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

import {
  fetchHeadBlockNumber,
  fetchOracleInputs,
  type OraclePollInputs,
} from './transport.js'
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
  /**
   * When `true` (default), the poll loop is gated on having at least
   * one active subscriber. `start()` is still called explicitly, but
   * the loop only actually fires `eth_*` calls when a subscriber is
   * attached. The 0 → 1 subscriber transition triggers an immediate
   * cycle plus interval start; the n → 0 transition pauses (subject
   * to `staleAfter`).
   *
   * This avoids the dapp-pattern foot-gun where two oracles
   * (PulseChain + Base) keep hot-polling at 10s intervals while the
   * user is on a static page that doesn't read either. Set `false`
   * to restore the v0.2.5 always-poll-after-start behavior.
   *
   * IMPORTANT: with `pauseWhenIdle: true`, `getState()` returns
   * `null` until either (a) a subscriber attaches, OR (b) the caller
   * runs `pollOnce()` once to seed state. Callers that pull state
   * synchronously without subscribing should either subscribe to a
   * no-op (`oracle.subscribe(() => {})`) or seed via `pollOnce()`.
   */
  pauseWhenIdle?: boolean
  /**
   * Wall-clock window (ms) to keep the poll loop alive after the last
   * subscriber detaches, before pausing. Useful for "snappy UI
   * re-mount" where a component briefly unmounts then re-mounts (e.g.
   * route transitions). Cached state stays warm during this window.
   *
   * Default `0` (pause immediately on last unsubscribe). Set to e.g.
   * `5_000` to keep the loop running for 5s after the last consumer
   * leaves. Ignored when `pauseWhenIdle` is `false`.
   */
  staleAfter?: number
  /**
   * When `true` (default), each tick first fires a cheap
   * `eth_blockNumber` probe. If the head hasn't moved since the
   * previous tick, the rest of the cycle is skipped — no expensive
   * `eth_getBlockByNumber(_, true)` / `eth_feeHistory` /
   * `txpool_content`. The fee landscape can't change without a new
   * block, so polling faster than block time is wasted RPC.
   *
   * For chains with sub-second blocks (some L2s), this is a no-op
   * because the head moves every tick anyway. For PulseChain (~10s)
   * and Ethereum (12s) on a 10s poll interval, this collapses ~90%
   * of ticks down to a single probe call.
   *
   * `pollOnce()` always bypasses the gate — explicit out-of-band
   * polls fire the full cycle.
   */
  blockGatedPolling?: boolean
  /**
   * When `true`, the oracle subscribes to the browser's
   * `visibilitychange` event and pauses the poll loop while the tab
   * is hidden. Resumes (and emits a fresh sample) on
   * `visibilityState === 'visible'`. Default `false`.
   *
   * Browsers already throttle background-tab timers but don't pause
   * network requests — explicit pause is several × cheaper. Safe to
   * enable in any browser context; auto-no-ops in Node / SSR /
   * Web Worker contexts where `document` is undefined.
   */
  pauseWhenHidden?: boolean
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
  const pauseWhenIdle = options.pauseWhenIdle !== false
  const blockGatedPolling = options.blockGatedPolling !== false
  const staleAfter = options.staleAfter ?? 0
  const pauseWhenHidden = options.pauseWhenHidden === true

  let state: GasOracleState | null = null
  let mempoolSnapshot: NormalizedMempool | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  let lastSeenBlock: bigint | null = null
  let started = false
  let visibilityListener: (() => void) | null = null
  const subscribers = new Set<(s: GasOracleState) => void>()

  const notify = (next: GasOracleState): void => {
    for (const cb of subscribers) {
      try { cb(next) } catch { /* swallow per-subscriber errors */ }
    }
  }

  // The expensive cycle: full RPC fan-out + reduce + notify. Used
  // unconditionally by `pollOnce()` and as the second step of the
  // tick when block-gating allows.
  const fullCycle = async (): Promise<GasOracleState | null> => {
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
      lastSeenBlock = next.blockNumber
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

  // The interval-driven cycle. Cheap-probes the head block first;
  // skips the expensive bits when the head hasn't moved.
  const tickCycle = async (): Promise<GasOracleState | null> => {
    if (blockGatedPolling) {
      const head = await fetchHeadBlockNumber(
        options.client,
        options.onError ? (err) => options.onError!('eth_blockNumber', err) : undefined,
      )
      if (head !== null && lastSeenBlock !== null && head === lastSeenBlock) {
        // Head hasn't moved — no fee-landscape change is possible.
        // Skip the expensive cycle. State and subscribers are
        // unchanged from the previous tick.
        return state
      }
      // head === null (probe failed) falls through to fullCycle —
      // we'd rather pay one extra cycle than block on a flaky
      // upstream that can't even report `eth_blockNumber`.
    }
    return fullCycle()
  }

  const startLoop = (): void => {
    if (timer !== null) return
    if (staleTimer !== null) {
      clearTimeout(staleTimer)
      staleTimer = null
    }
    // Fire-and-forget the first cycle so callers don't block on RPC
    // latency. The interval picks up from there.
    void tickCycle()
    timer = setInterval(() => { void tickCycle() }, pollIntervalMs)
  }

  const pauseLoop = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (staleTimer !== null) {
      clearTimeout(staleTimer)
      staleTimer = null
    }
  }

  const scheduleIdlePause = (): void => {
    if (staleAfter <= 0) {
      pauseLoop()
      return
    }
    if (staleTimer !== null) return
    staleTimer = setTimeout(() => {
      pauseLoop()
      staleTimer = null
    }, staleAfter)
  }

  // Structural shape of the bits of `document` we use — kept narrow
  // so the package doesn't need the DOM lib in tsconfig (`lib: ES2020`).
  // The runtime check below is the only place this ever matters.
  interface VisibilityDoc {
    hidden: boolean
    addEventListener: (event: 'visibilitychange', listener: () => void) => void
    removeEventListener: (event: 'visibilitychange', listener: () => void) => void
  }
  const documentRef: VisibilityDoc | undefined =
    typeof globalThis !== 'undefined' && 'document' in globalThis
      ? (globalThis as { document?: VisibilityDoc }).document
      : undefined

  const setupVisibilityHandling = (): void => {
    if (!pauseWhenHidden || !documentRef) return
    const listener = (): void => {
      if (documentRef.hidden) {
        pauseLoop()
        return
      }
      // Tab became visible — resume if we have a reason to (no
      // subscriber-gating, OR subscribers are present).
      if (!pauseWhenIdle || subscribers.size > 0) {
        startLoop()
      }
    }
    documentRef.addEventListener('visibilitychange', listener)
    visibilityListener = listener
  }

  const teardownVisibilityHandling = (): void => {
    if (visibilityListener && documentRef) {
      documentRef.removeEventListener('visibilitychange', visibilityListener)
    }
    visibilityListener = null
  }

  const isHidden = (): boolean => documentRef?.hidden === true

  return {
    start: () => {
      if (started) return
      started = true
      setupVisibilityHandling()
      // Only actually start the loop if (a) we don't gate on
      // subscribers, OR (b) there's already a subscriber attached
      // (rare but valid: subscribe before start). Visibility wins
      // over both — never poll while hidden if pauseWhenHidden is on.
      if (pauseWhenHidden && isHidden()) return
      if (!pauseWhenIdle || subscribers.size > 0) {
        startLoop()
      }
    },
    stop: () => {
      pauseLoop()
      teardownVisibilityHandling()
      state = null
      mempoolSnapshot = null
      lastSeenBlock = null
      started = false
    },
    getState: () => state,
    getMempoolSnapshot: () => mempoolSnapshot,
    // pollOnce explicitly bypasses block-gating — caller asked for a
    // sample, give them a full one. State/lastSeenBlock are still
    // updated so the next tick can gate against this.
    pollOnce: () => fullCycle(),
    subscribe: (cb) => {
      subscribers.add(cb)
      // 0 → 1 transition: kick the loop awake (or cancel the
      // stale-after pause that was about to fire).
      if (started && pauseWhenIdle && subscribers.size === 1) {
        if (!pauseWhenHidden || !isHidden()) {
          startLoop()
        }
      }
      return () => {
        subscribers.delete(cb)
        // n → 0 transition: schedule pause.
        if (started && pauseWhenIdle && subscribers.size === 0) {
          scheduleIdlePause()
        }
      }
    },
  }
}

/**
 * One-shot sample helper for callers who need a single fee snapshot
 * without standing up a long-lived oracle. Right for tx-submit flows
 * that price one transaction and don't need streaming updates.
 *
 * Composes the existing `fetchOracleInputs` (I/O) + `reducePollInputs`
 * (pure) split — see README "RPC transport modes" for the offline
 * variant where you supply your own `OraclePollInputs`.
 *
 * @example
 *   const snapshot = await sampleGasFees({
 *     client,
 *     chainId: 1,
 *     priorityModel: 'eip1559',
 *   })
 *   const tip = snapshot?.tiers.fast.maxPriorityFeePerGas
 */
export const sampleGasFees = async (options: {
  /** viem PublicClient pointed at the upstream RPC. */
  client: PublicClient
  /** EVM chain ID. Echoed back in the result. */
  chainId: number
  /** See `CreateGasOracleOptions.priorityFeeDecayCap`. */
  priorityFeeDecayCap?: bigint | null
  /** See `CreateGasOracleOptions.priorityModel`. */
  priorityModel?: PriorityModel
  /** See `CreateGasOracleOptions.baseFeeLivenessBlocks`. */
  baseFeeLivenessBlocks?: number
  /** See `CreateGasOracleOptions.poll`. */
  poll?: PollOptions
  /** See `CreateGasOracleOptions.onError`. */
  onError?: (method: string, err: unknown) => void
}): Promise<GasOracleState | null> => {
  const inputs = await fetchOracleInputs(options.client, {
    onError: options.onError,
    poll: options.poll,
  })
  return reducePollInputs({
    inputs,
    chainId: options.chainId,
    prev: null,
    priorityFeeDecayCap: options.priorityFeeDecayCap,
    priorityModel: options.priorityModel,
    baseFeeLivenessBlocks: options.baseFeeLivenessBlocks,
  })
}

// Re-export for callers who want to drive the reducer directly (e.g.,
// running off a fixed RPC log instead of live polling).
export type { OraclePollInputs } from './transport.js'
export type { TierName } from './types.js'
