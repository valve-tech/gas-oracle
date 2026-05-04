/**
 * Gas oracle factory. Owns:
 *
 *   - the polling lifecycle (start/stop interval timer)
 *   - in-memory state for one chain
 *   - a subscriber list so callers can mirror published state to Redis,
 *     a websocket, a metrics gauge, etc. — the package itself stays
 *     transport-agnostic and zero-deps beyond the viem peer.
 *
 * One oracle instance per chain. If you need many chains in one
 * process, instantiate many oracles. They don't share any state.
 */

import type { PublicClient } from 'viem'

import { fetchOracleInputs, type OraclePollInputs } from './transport.js'
import {
  computeBlobBaseFee,
  computeTiers,
  detectTrend,
  flattenTxPool,
} from './math.js'
import { normalizeMempool, type NormalizedMempool } from './mempool.js'
import { blockToSample, mempoolToSamples } from './samples.js'
import type {
  BlobStats,
  GasOracleState,
  MempoolStats,
  PollOptions,
  PriorityModel,
} from './types.js'

const DEFAULT_POLL_INTERVAL_MS = 10_000
const TREND_WINDOW = 5
const WAD = 1_000_000_000_000_000_000n

export interface CreateGasOracleOptions {
  /** viem PublicClient pointed at the upstream RPC for this chain. */
  client: PublicClient
  /** EVM chain ID. Echoed back in `state.chainId`; not validated. */
  chainId: number
  /** Polling interval in ms. Default 10_000. */
  pollIntervalMs?: number
  /**
   * Optional error sink. Called for each sub-RPC that fails inside a
   * poll cycle. Default behavior is to swallow — the oracle keeps running
   * on partial data. Useful for routing failures into a debug logger or
   * a metrics counter.
   */
  onError?: (method: string, err: unknown) => void
  /**
   * Maximum fraction the published priority-fee tip may drop per block
   * elapsed since the last publish. Wad-scaled bigint: 1e18 = 100%.
   * Pass `parseEther('0.125')` for the default 12.5%/block (EIP-1559
   * parity). `null` disables capping entirely. Validated at construction
   * to fall in `[0n, WAD]` when not null.
   */
  priorityFeeDecayCap?: bigint | null
  /**
   * Where the chain draws its priority cutoff in the EIP-2718 type space.
   * `'flat'` (default) treats every tx equally — right for extractive
   * networks. `'eip1559'` derives standard/fast/instant from type-2+
   * samples only — right for chains that honor 1559 ordering.
   */
  priorityModel?: PriorityModel
  /**
   * How many blocks the published recommendation should survive in the
   * worst case. The buffered base fee underpinning `maxFeePerGas` becomes
   * `baseFee * (9/8)^N` (the EIP-1559 worst-case rise compounded), so a
   * tx submitted with the current snapshot still lands within `N` blocks
   * even if every intervening block is full. Default `1` (one block of
   * headroom — matches pre-v0.2 behavior). A wallet that wants its
   * recommendation to last ~1.5 minutes on Ethereum (~6 blocks at 12s)
   * sets this to `6`. Validated `>= 1`.
   */
  baseFeeLivenessBlocks?: number
  /**
   * Producer-side toggles for upstream RPC calls. `feeHistory` and
   * `mempool` default true; setting either to false skips that RPC
   * entirely each cycle. `eth_getBlockByNumber` is not toggleable.
   */
  poll?: PollOptions
  /**
   * When `true`, the oracle retains the latest normalized mempool
   * snapshot and exposes it via `getMempoolSnapshot()`. The snapshot
   * powers `findInMempool` / `tipForBlockPosition({ kind: 'aheadOf' })`-
   * style lookups without a second RPC roundtrip. Memory cost is the
   * size of one `txpool_content` payload (5–15MB on busy ETH mainnet);
   * keep this off in browser/mobile contexts. Default `false`.
   */
  keepMempoolSnapshot?: boolean
}

export interface GasOracle {
  /** Begin the poll loop. Idempotent — calling twice is a no-op. */
  start: () => void
  /** Stop polling and clear in-memory state. */
  stop: () => void
  /** Latest known state, or null if no successful poll has completed yet. */
  getState: () => GasOracleState | null
  /**
   * Latest normalized mempool snapshot, or `null` if `keepMempoolSnapshot`
   * is off, no poll has yet succeeded, or the most recent poll's
   * `txpool_content` failed (provider gated, etc.). Always returns the
   * normalized form — addresses lowercase, nonces decimalized — so
   * callers can pass it directly into `findInMempool` /
   * `tipForBlockPosition`.
   */
  getMempoolSnapshot: () => NormalizedMempool | null
  /**
   * Run one poll cycle out-of-band and return the resulting state.
   * Useful for tests, on-demand refreshes, or running without the
   * interval timer (e.g., serverless). Resolves to null if the cycle
   * couldn't produce state (no block fetched).
   */
  pollOnce: () => Promise<GasOracleState | null>
  /**
   * Subscribe to state updates. The callback fires after every
   * successful poll cycle with the new state. Returns an unsubscribe
   * function. Subscribers fire synchronously; if a subscriber throws,
   * the error is swallowed so one bad consumer can't take down the
   * oracle's other listeners.
   */
  subscribe: (cb: (state: GasOracleState) => void) => () => void
}

/**
 * Reduce a poll cycle's RPC outputs into a new oracle state, using the
 * previous state to anchor the cap-decay and the base-fee history.
 *
 * Pure: no I/O, no global state, no time. Test by feeding it fixture
 * inputs and asserting the returned shape.
 */
export const reducePollInputs = (input: {
  inputs: OraclePollInputs
  chainId: number
  prev: GasOracleState | null
  priorityFeeDecayCap?: bigint | null
  priorityModel?: PriorityModel
  baseFeeLivenessBlocks?: number
}): GasOracleState | null => {
  const { block, feeHistory, txPool } = input.inputs
  if (!block) return null

  const blockNumber = BigInt(block.number)
  const timestamp = BigInt(block.timestamp)
  const baseFee = BigInt(block.baseFeePerGas)
  const blockGasLimit = BigInt(block.gasLimit)

  // Base-fee history: prefer feeHistory's window, fall back to a
  // single-element array so detectTrend has something to chew on.
  const baseFeeHistory: bigint[] = feeHistory
    ? feeHistory.baseFeePerGas.map((hex) => BigInt(hex))
    : [baseFee]
  const baseFeeTrend = detectTrend(baseFeeHistory.slice(-TREND_WINDOW))

  // Build the rolling ring. The full 20-block append/bridgeGap/clear
  // lifecycle is deferred (spec §7-§9); for now we keep window = 1 by
  // populating ring as a single-element array from the current block.
  // Forward-compatible: callers can read `state.ring` as a list of
  // BlockSamples without caring how many entries are in it.
  const blockSample = blockToSample(block)
  const ring = [blockSample]
  const ringSamples = blockSample.tips

  // Mempool — best-effort signal.
  let mempool: MempoolStats = {
    pendingCount: 0,
    queuedCount: 0,
    pendingGasDemand: 0n,
    blockGasLimit,
  }
  let mempoolSamples = mempoolToSamples(txPool, baseFee)
  if (txPool) {
    const pendingTxs = flattenTxPool(txPool.pending)
    const queuedTxs = flattenTxPool(txPool.queued)
    mempool = {
      pendingCount: pendingTxs.length,
      queuedCount: queuedTxs.length,
      pendingGasDemand: pendingTxs.reduce(
        (sum, tx) => sum + (tx.gas ? BigInt(tx.gas) : 0n),
        0n,
      ),
      blockGasLimit,
    }
  } else {
    mempoolSamples = []
  }

  // EIP-4844 blob — only on chains that expose excessBlobGas.
  let blob: BlobStats | null = null
  if (block.excessBlobGas !== undefined) {
    const excessBlobGas = BigInt(block.excessBlobGas)
    const blobGasUsed = BigInt(block.blobGasUsed ?? '0x0')
    const blobBaseFee = computeBlobBaseFee(excessBlobGas)
    const prevBlobHistory = input.prev?.blob ? [input.prev.blob.blobBaseFee, blobBaseFee] : [blobBaseFee]
    blob = {
      blobBaseFee,
      excessBlobGas,
      blobGasUsed,
      blobBaseFeeTrend: detectTrend(prevBlobHistory),
    }
  }

  const blobInput = blob ? { blobBaseFee: blob.blobBaseFee, trend: blob.blobBaseFeeTrend } : null
  const { tiers, publishedTips } = computeTiers({
    ringSamples,
    mempoolSamples,
    baseFee,
    baseFeeTrend,
    blob: blobInput,
    blockNumber,
    lastPublishedTips: input.prev?.lastPublishedTips,
    lastPublishedBlockNumber: input.prev?.lastPublishedBlockNumber,
    priorityFeeDecayCap: input.priorityFeeDecayCap,
    priorityModel: input.priorityModel,
    baseFeeLivenessBlocks: input.baseFeeLivenessBlocks,
  })

  return {
    chainId: input.chainId,
    blockNumber,
    timestamp,
    baseFee,
    baseFeeTrend,
    baseFeeHistory,
    mempool,
    blob,
    tiers,
    ring,
    lastPublishedTips: publishedTips,
    lastPublishedBlockNumber: blockNumber,
  }
}

/**
 * Build a configured oracle. Nothing happens until you call `start()`.
 *
 * @example
 *   import { createPublicClient, http } from 'viem'
 *   import { mainnet } from 'viem/chains'
 *   import { createGasOracle } from '@valve-tech/gas-oracle'
 *
 *   const client = createPublicClient({ chain: mainnet, transport: http() })
 *   const oracle = createGasOracle({ client, chainId: 1 })
 *   oracle.subscribe((state) => publishToRedis(state))
 *   oracle.start()
 *
 *   // Later — sub-ms read, no RPC:
 *   const tier = oracle.getState()?.tiers.standard
 */
export const createGasOracle = (options: CreateGasOracleOptions): GasOracle => {
  // Validate at the boundary so misconfigured callers fail fast rather
  // than producing silently-wrong tier numbers later.
  if (
    options.priorityFeeDecayCap !== undefined &&
    options.priorityFeeDecayCap !== null
  ) {
    const cap = options.priorityFeeDecayCap
    if (cap < 0n || cap > WAD) {
      throw new Error(
        `priorityFeeDecayCap must be in [0n, ${WAD}] (wad-scale; null = uncapped); got ${cap}`,
      )
    }
  }
  if (
    options.baseFeeLivenessBlocks !== undefined &&
    (!Number.isInteger(options.baseFeeLivenessBlocks) || options.baseFeeLivenessBlocks < 1)
  ) {
    throw new Error(
      `baseFeeLivenessBlocks must be a positive integer; got ${options.baseFeeLivenessBlocks}`,
    )
  }

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const retainMempool = options.keepMempoolSnapshot === true
  let state: GasOracleState | null = null
  let mempoolSnapshot: NormalizedMempool | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  const subscribers = new Set<(s: GasOracleState) => void>()

  const notify = (next: GasOracleState): void => {
    for (const cb of subscribers) {
      try { cb(next) } catch { /* swallow per-subscriber errors */ }
    }
  }

  const cycle = async (): Promise<GasOracleState | null> => {
    const inputs = await fetchOracleInputs(options.client, {
      onError: options.onError,
      poll: options.poll,
    })
    const next = reducePollInputs({
      inputs,
      chainId: options.chainId,
      prev: state,
      priorityFeeDecayCap: options.priorityFeeDecayCap,
      priorityModel: options.priorityModel,
      baseFeeLivenessBlocks: options.baseFeeLivenessBlocks,
    })
    if (next) {
      state = next
      if (retainMempool) {
        // Re-normalize each cycle. `inputs.txPool` is null when the
        // mempool RPC is gated/disabled — store an empty snapshot
        // rather than leaving stale data from a prior cycle around.
        mempoolSnapshot = normalizeMempool(inputs.txPool)
      }
      notify(next)
    }
    return next
  }

  return {
    start: () => {
      if (timer !== null) return
      // Fire-and-forget the first cycle so callers don't block on RPC
      // latency. The interval picks up from there.
      void cycle()
      timer = setInterval(() => { void cycle() }, pollIntervalMs)
    },
    stop: () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      state = null
      mempoolSnapshot = null
    },
    getState: () => state,
    getMempoolSnapshot: () => mempoolSnapshot,
    pollOnce: () => cycle(),
    subscribe: (cb) => {
      subscribers.add(cb)
      return () => { subscribers.delete(cb) }
    },
  }
}

// Re-export for callers who want to drive the reducer directly (e.g.,
// running off a fixed RPC log instead of live polling).
export type { OraclePollInputs } from './transport.js'
export type { TierName } from './types.js'
