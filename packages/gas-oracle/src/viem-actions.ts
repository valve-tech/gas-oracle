/**
 * @valve-tech/gas-oracle/viem-actions — viem client extension.
 *
 * Use when callers want explicit access to the structured tier shape:
 *
 *   const client = createPublicClient({ chain, transport: http() })
 *     .extend(gasOracleActions({
 *       chainId: 1,
 *       priorityFeeDecayCap: parseEther('0.125'),
 *       priorityModel: 'eip1559',
 *     }))
 *
 *   await client.getGasTiers()        // full snapshot
 *   await client.getGasTier('fast')   // one tier
 *
 * The actions own a per-extension `GasOracle` keyed off the supplied
 * chainId. The poll loop starts eagerly by default so the first read is
 * served from a populated cache; pass `lifecycle: 'lazy'` to defer
 * polling to the first read instead. Either way the underlying client
 * is what drives the upstream RPC (the same transport viem already
 * uses for everything else), so callers don't have to wire a second
 * URL just to feed the oracle.
 *
 * Stopping the poller is the caller's responsibility — viem clients
 * have no explicit lifecycle, so `stopGasOracle()` is exposed on the
 * extended client for shutdown hooks (Next.js HMR, test teardown,
 * one-shot scripts) that need to drop the interval timer cleanly.
 */

import type { PublicClient } from 'viem'

import {
  tipForBlockPosition,
  type BlockPositionQuery,
  type BlockPositionResult,
} from './block-position.js'
import type { NormalizedMempool, TxPoolContent } from '@valve-tech/chain-source'

import {
  findInMempool,
  normalizeMempool,
  type MempoolHit,
  type TxIdentifier,
} from './mempool.js'
import { createGasOracle, type CreateGasOracleOptions, type GasOracle } from './oracle.js'
import type { GasOracleState, TierName, TierRecommendation, TipSample } from './types.js'

export interface GasOracleActionsOptions extends Omit<CreateGasOracleOptions, 'client'> {
  /**
   * When the oracle starts polling.
   * - `'eager'` (default): poll loop begins as soon as the extension is
   *   attached — first read is served from cache.
   * - `'lazy'`:            poll loop starts on the first `getGasTiers`
   *                        / `getGasTier` call. Trades a small first-read
   *                        latency for not running background RPCs the
   *                        caller never asked for.
   */
  lifecycle?: 'eager' | 'lazy'
}

export interface GasOracleActions {
  /**
   * Latest tier snapshot. When state hasn't been populated yet (cold
   * start), runs an out-of-band poll to seed it before returning.
   */
  getGasTiers: () => Promise<GasOracleState>
  /** One specific tier's recommendation. Same backing state as getGasTiers. */
  getGasTier: (name: TierName) => Promise<TierRecommendation>
  /**
   * Look up a tx in the mempool by hash or by sender address + nonce.
   * When `keepMempoolSnapshot: true` is set on the actions options,
   * served from the oracle's cached snapshot (no extra RPC); otherwise
   * issues an on-demand `txpool_content` request.
   */
  findTxInMempool: (id: TxIdentifier) => Promise<MempoolHit | null>
  /**
   * Compute the tip required to land at a target position in the next
   * block. Distribution = ring (last block) ∪ pending mempool, the
   * same union `computeTiers` reads. When mempool data isn't available
   * (gated upstream / `keepMempoolSnapshot: false` / first cold-start
   * read), falls back to ring-only.
   */
  tipForBlockPosition: (query: BlockPositionQuery) => Promise<BlockPositionResult>
  /**
   * Stop the underlying poller. Idempotent. After stop, subsequent
   * reads will throw — there's no auto-restart, since restart timing
   * is the caller's concern (HMR vs. test teardown vs. real shutdown).
   */
  stopGasOracle: () => void
}

export const gasOracleActions = (options: GasOracleActionsOptions) =>
  (client: PublicClient): GasOracleActions => {
    // viem-actions consumers pull state via `client.getGasTiers()`
    // etc. — they don't subscribe. Default `pauseWhenIdle: false`
    // here so the eager lifecycle keeps the cache warm even without
    // an explicit subscriber. Callers who want subscriber-gated
    // behavior should construct an oracle directly instead of
    // going through actions.
    const oracle: GasOracle = createGasOracle({
      pauseWhenIdle: false,
      ...options,
      client,
    })
    const lifecycle = options.lifecycle ?? 'eager'
    let started = false
    if (lifecycle === 'eager') {
      oracle.start()
      started = true
    }

    const ensureState = async (): Promise<GasOracleState> => {
      if (!started) {
        oracle.start()
        started = true
      }
      const cached = oracle.getState()
      if (cached) return cached
      const polled = await oracle.pollOnce()
      if (!polled) {
        throw new Error(
          `[gas-oracle] poll cycle returned no state — upstream block fetch failed for chain ${options.chainId}`,
        )
      }
      return polled
    }

    /**
     * Pull a fresh mempool snapshot — from the oracle's cache when
     * `keepMempoolSnapshot: true`, otherwise via an on-demand RPC.
     * Falls back to `null` when the upstream gates `txpool_content`.
     */
    const fetchMempool = async (): Promise<NormalizedMempool | null> => {
      const cached = oracle.getMempoolSnapshot()
      if (cached) return cached
      try {
        const raw = (await client.request({
          method: 'txpool_content',
          params: [],
        } as never)) as TxPoolContent | null
        return raw ? normalizeMempool(raw) : null
      } catch {
        return null
      }
    }

    return {
      getGasTiers: ensureState,
      getGasTier: async (name) => (await ensureState()).tiers[name],
      findTxInMempool: async (id) => findInMempool(await fetchMempool(), id),
      tipForBlockPosition: async (query) => {
        const state = await ensureState()
        const ringSamples: TipSample[] = state.ring.flatMap((b) => b.tips)
        const mempool = await fetchMempool()
        const mempoolSamples: TipSample[] = mempool
          ? Object.entries(mempool.pending).flatMap(([address, byNonce]) =>
              Object.entries(byNonce).flatMap(([nonce, tx]): TipSample[] => {
                if (tx.gas === undefined) return []
                const tip = (() => {
                  if (tx.maxFeePerGas && tx.maxPriorityFeePerGas) {
                    const maxFee = BigInt(tx.maxFeePerGas)
                    const maxPriority = BigInt(tx.maxPriorityFeePerGas)
                    const headroom = maxFee - state.baseFee
                    if (headroom <= 0n) return 0n
                    return maxPriority < headroom ? maxPriority : headroom
                  }
                  if (tx.gasPrice) {
                    const price = BigInt(tx.gasPrice)
                    return price > state.baseFee ? price - state.baseFee : 0n
                  }
                  return 0n
                })()
                return [
                  {
                    tip,
                    gas: BigInt(tx.gas),
                    txType: tx.type !== undefined ? Number(tx.type) : undefined,
                    hash: tx.hash,
                    address,
                    nonce,
                  },
                ]
              }),
            )
          : []
        return tipForBlockPosition([...ringSamples, ...mempoolSamples], query)
      },
      stopGasOracle: () => oracle.stop(),
    }
  }
