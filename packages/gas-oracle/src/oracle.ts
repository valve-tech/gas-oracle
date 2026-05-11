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
  createChainSource,
  type BlockResult,
  type ChainSource,
  type NormalizedMempool,
  type PollOptions,
} from '@valve-tech/chain-source'

import { fetchOracleInputs, type OraclePollInputs } from './transport.js'
import {
  computeBlobBaseFee,
  computeTiers,
  detectTrend,
  flattenTxPool,
} from './math.js'
import { incorporateBlock } from './ring.js'
import { blockToSample, mempoolToSamples } from './samples.js'
import type {
  BlobStats,
  BlockSample,
  GasOracleState,
  MempoolStats,
  PriorityModel,
} from './types.js'

const DEFAULT_POLL_INTERVAL_MS = 10_000n
const TREND_WINDOW = 5
const WAD = 1_000_000_000_000_000_000n

export interface CreateGasOracleOptions {
  /**
   * Pre-built `ChainSource`. Preferred for new code: lets multiple
   * derived views (gas-oracle, tx-tracker, …) share one upstream poll
   * cycle. The consumer that constructed the source owns its
   * lifecycle — `oracle.start()` / `oracle.stop()` only attach and
   * detach the oracle's own subscribers; they do NOT start or stop
   * the source.
   *
   * Exactly one of `source` or `client` must be provided. Passing
   * both throws at construction.
   */
  source?: ChainSource
  /**
   * viem PublicClient pointed at the upstream RPC for this chain.
   * Backward-compat shorthand: when provided, the oracle constructs
   * a private `ChainSource` internally and owns its lifecycle
   * (`start()` starts the source, `stop()` stops it). Existing v0.5.x
   * call sites work unchanged.
   *
   * Exactly one of `source` or `client` must be provided.
   */
  client?: PublicClient
  /** EVM chain ID. Echoed back in `state.chainId`; not validated. */
  chainId: number
  /**
   * Polling interval in ms. Default 10_000n. Only consulted when the
   * oracle is constructing its own private `ChainSource` (i.e. when
   * `client` is provided). When a `source` is provided, the source's
   * own poll interval governs.
   */
  pollIntervalMs?: bigint
  /**
   * Optional error sink. Called for each sub-RPC that fails inside a
   * poll cycle. Default behavior is to swallow — the oracle keeps running
   * on partial data. Useful for routing failures into a debug logger or
   * a metrics counter.
   *
   * When the oracle owns a private `ChainSource` (i.e. `client` mode),
   * this sink is forwarded to the source so RPC errors at the upstream
   * layer surface here too.
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
   * @deprecated v0.6.0 — block-gated polling now lives in
   * `@valve-tech/chain-source` itself, via head-probe gating in its
   * tick. The option is retained for backward compatibility but is a
   * no-op: passing `false` no longer disables gating, and passing
   * `true` is the always-on behavior at the source layer. The
   * efficiency win (skip the expensive full-block fetch when the head
   * hasn't moved) now benefits every consumer of `ChainSource` — not
   * just gas-oracle — so the gate moved down a layer.
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
  /**
   * How many recent blocks to retain in `state.ring` for percentile
   * sampling and reorg detection. Default 20n (matches the
   * `eth_feeHistory` window). Pass 0n to disable the cap (the ring
   * grows without bound; only useful for replay harnesses).
   *
   * The ring fills naturally as the poll loop receives blocks, with
   * pre-fetched gap bridging via `source.getBlock` when consecutive
   * polls miss intermediate blocks. Larger windows give more samples
   * (more stable tier numbers) at the cost of more memory and more
   * I/O on resume after a long pause.
   */
  ringWindowBlocks?: bigint
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

const DEFAULT_RING_WINDOW_BLOCKS = 20n

/**
 * Reduce a poll cycle's RPC outputs into a new oracle state, using the
 * previous state to anchor the cap-decay and the base-fee history.
 *
 * Pure: no I/O, no global state, no time. Test by feeding it fixture
 * inputs and asserting the returned shape.
 *
 * Ring lifecycle. The reducer maintains `state.ring` across calls
 * using `incorporateBlock` (see `ring.ts`): clean appends, duplicate
 * detection, reorg trim, restart on irrecoverable gaps. The poll loop
 * in `createGasOracle` pre-fetches missing blocks for clean gaps and
 * passes them as `historicalBlocks` so the ring stays dense across
 * brief interruptions; callers using `reducePollInputs` directly
 * (replay harnesses, snapshot tests) can pass the same param.
 */
export const reducePollInputs = (input: {
  inputs: OraclePollInputs
  chainId: number
  prev: GasOracleState | null
  /**
   * Older blocks to slot into the ring before the current input block.
   * Ordered oldest → newest. Used by the I/O-driven gap bridge in
   * `oracle.ts`'s poll loop and by replay harnesses; standalone callers
   * can omit it. Each historical block contributes its `tips` to the
   * percentile sample base; `feeHistory` and `txPool` from `inputs`
   * still apply to the current block only.
   */
  historicalBlocks?: BlockResult[]
  priorityFeeDecayCap?: bigint | null
  priorityModel?: PriorityModel
  baseFeeLivenessBlocks?: number
  /**
   * Maximum ring size. Defaults to 20 blocks (matching the
   * `eth_feeHistory` window). Pass 0n to disable the cap. Older
   * entries are dropped from the head as new appends would exceed
   * the window.
   */
  ringWindowBlocks?: bigint
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

  // Build the rolling ring. Pure helper handles append / duplicate /
  // reorg-trim / restart; the I/O-driven gap bridge happens in
  // `handleBlock` and arrives here pre-fetched via `historicalBlocks`.
  const ringWindow = input.ringWindowBlocks ?? DEFAULT_RING_WINDOW_BLOCKS
  let workingRing: BlockSample[] = input.prev?.ring ?? []
  let lastReorg = input.prev?.lastReorg ?? null
  for (const histBlock of input.historicalBlocks ?? []) {
    const histMutation = incorporateBlock(workingRing, blockToSample(histBlock), ringWindow)
    workingRing = histMutation.ring
    if (histMutation.reorg) lastReorg = histMutation.reorg
  }
  const blockSample = blockToSample(block)
  const mutation = incorporateBlock(workingRing, blockSample, ringWindow)
  const ring = mutation.ring
  if (mutation.reorg) lastReorg = mutation.reorg
  const ringSamples = ring.flatMap((b) => b.tips)

  // Mempool — best-effort signal.
  let mempool: MempoolStats = {
    pendingCount: 0n,
    queuedCount: 0n,
    pendingGasDemand: 0n,
    blockGasLimit,
  }
  let mempoolSamples = mempoolToSamples(txPool, baseFee)
  if (txPool) {
    const pendingTxs = flattenTxPool(txPool.pending)
    const queuedTxs = flattenTxPool(txPool.queued)
    mempool = {
      pendingCount: BigInt(pendingTxs.length),
      queuedCount: BigInt(queuedTxs.length),
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
    lastReorg,
    mempoolSamples,
    lastPublishedTips: publishedTips,
    lastPublishedBlockNumber: blockNumber,
  }
}

/**
 * Build a configured oracle. Nothing happens until you call `start()`.
 *
 * Two construction shapes — pick one:
 *
 *   // v0.5.x backward-compat: oracle owns a private ChainSource.
 *   import { createPublicClient, http } from 'viem'
 *   import { mainnet } from 'viem/chains'
 *   import { createGasOracle } from '@valve-tech/gas-oracle'
 *
 *   const client = createPublicClient({ chain: mainnet, transport: http() })
 *   const oracle = createGasOracle({ client, chainId: 1 })
 *   oracle.subscribe((state) => publishToRedis(state))
 *   oracle.start()
 *
 *   // v0.6.0+: share a ChainSource with other consumers (e.g. tx-tracker).
 *   import { createChainSource } from '@valve-tech/chain-source'
 *
 *   const source  = createChainSource({ client })
 *   const oracle  = createGasOracle({ source, chainId: 1 })
 *   const tracker = createTxTracker({ source, chainId: 1 })  // future
 *   source.start(); oracle.start(); tracker.start()
 *
 *   // Later — sub-ms read, no RPC:
 *   const tier = oracle.getState()?.tiers.standard
 */
export const createGasOracle = (options: CreateGasOracleOptions): GasOracle => {
  // Validate exactly-one of source/client at the boundary. Misconfigured
  // callers fail fast at construction rather than producing silently
  // bad behavior at run time.
  const hasSource = options.source !== undefined
  const hasClient = options.client !== undefined
  if (hasSource && hasClient) {
    throw new Error(
      'createGasOracle: pass exactly one of `source` or `client`, not both. ' +
        'Use `source` to share an upstream poll cycle with other consumers; ' +
        'use `client` for the v0.5.x backward-compat shorthand (oracle constructs a private source).',
    )
  }
  if (!hasSource && !hasClient) {
    throw new Error(
      'createGasOracle: pass exactly one of `source` or `client`. ' +
        'Use `source` to share an upstream poll cycle with other consumers; ' +
        'use `client` for the v0.5.x backward-compat shorthand.',
    )
  }
  if (
    options.priorityFeeDecayCap !== undefined &&
    options.priorityFeeDecayCap !== null
  ) {
    const cap = options.priorityFeeDecayCap
    // Split into two ifs: v8 short-circuits the `||` arm coverage.
    if (cap < 0n) {
      throw new Error(
        `priorityFeeDecayCap must be in [0n, ${WAD}] (wad-scale; null = uncapped); got ${cap}`,
      )
    }
    if (cap > WAD) {
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
  const staleAfter = options.staleAfter ?? 0
  const pauseWhenHidden = options.pauseWhenHidden === true
  const fetchFeeHistoryEnabled = options.poll?.feeHistory !== false
  const fetchMempoolEnabled = options.poll?.mempool !== false

  // Adopt or construct the ChainSource. `ownsSource` controls whether
  // the oracle's start/stop also drives the source's lifecycle — when
  // a source was provided externally, the consumer manages it.
  const ownsSource = !hasSource
  const source: ChainSource =
    options.source ??
    createChainSource({
      // hasClient is true when hasSource is false, by the validation above.
      client: options.client as PublicClient,
      pollIntervalMs: Number(pollIntervalMs),
      poll: options.poll,
      onError: options.onError,
    })

  let state: GasOracleState | null = null
  // Cached mempool snapshot powering `getMempoolSnapshot()` — populated
  // only when `keepMempoolSnapshot` is on.
  let mempoolSnapshot: NormalizedMempool | null = null
  // Latest mempool snapshot received from `source.subscribeMempool`.
  // Used as input to the next reduce regardless of `keepMempoolSnapshot`.
  let latestMempool: NormalizedMempool | null = null
  let unsubBlocks: (() => void) | null = null
  let unsubMempool: (() => void) | null = null
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let visibilityListener: (() => void) | null = null
  const subscribers = new Set<(s: GasOracleState) => void>()

  const notify = (next: GasOracleState): void => {
    for (const cb of subscribers) {
      try { cb(next) } catch { /* swallow per-subscriber errors */ }
    }
  }

  const ringWindowBlocks = options.ringWindowBlocks ?? DEFAULT_RING_WINDOW_BLOCKS

  /**
   * Reduce a (block, feeHistory, mempool) tuple into the next state +
   * notify. Shared between the subscribe-driven path (timer ticks)
   * and the on-demand path (`pollOnce`). `historicalBlocks` carries
   * any gap-bridge blocks fetched by `handleBlock` so the ring fills
   * in chronological order in a single reducer call (one notification).
   *
   * The `block` field on `inputs` is **required non-null** here —
   * both callers (`handleBlock` and `pollOnce`) already gate on a
   * non-null block, so the pure reducer's null-block-early-return
   * arm cannot fire from this path. Typing the parameter
   * accordingly removes the dead `if (next)` guard and the
   * `c8 ignore` directive that was needed to silence coverage.
   */
  const reduceAndPublish = (
    inputs: OraclePollInputs & { block: BlockResult },
    historicalBlocks?: BlockResult[],
  ): GasOracleState => {
    const next = reducePollInputs({
      inputs,
      historicalBlocks,
      chainId: options.chainId,
      prev: state,
      priorityFeeDecayCap: options.priorityFeeDecayCap,
      priorityModel: options.priorityModel,
      baseFeeLivenessBlocks: options.baseFeeLivenessBlocks,
      ringWindowBlocks,
    }) as GasOracleState
    state = next
    notify(next)
    return next
  }

  /**
   * Pre-fetch missing blocks between `prev.ring`'s tip and `newBlock`
   * so the reducer's ring stays dense across brief upstream pauses.
   *
   * Bounded by `ringWindowBlocks` — gaps larger than the window
   * trigger a ring restart anyway, so spending RPC calls to bridge
   * them is wasted. Each missing block is fetched by number via
   * `source.getBlock`. Failures are silently dropped: a partial bridge
   * still leaves the new block as the new tip, and the reducer's pure
   * helper handles incomplete ancestry by restarting if necessary.
   *
   * Reorgs (parentHash mismatch with `prev.tip.hash`) are NOT
   * backfilled here — that would require fetching by hash, which
   * `chain-source` doesn't expose. The reducer's trim handles them
   * correctly; the new canonical branch refills via natural forward
   * polling.
   */
  const bridgeGap = async (newBlock: BlockResult): Promise<BlockResult[]> => {
    if (state === null || state.ring.length === 0) return []
    const tip = state.ring[state.ring.length - 1]
    const newNumber = BigInt(newBlock.number)
    const gap = newNumber - tip.number
    if (gap <= 1n) return []
    if (ringWindowBlocks > 0n && gap > ringWindowBlocks) return []
    const missing: BlockResult[] = []
    for (let n = tip.number + 1n; n < newNumber; n += 1n) {
      const fetched = await source.getBlock(n)
      if (!fetched) break
      missing.push(fetched)
    }
    return missing
  }

  // Block-event handler. Fires once per de-duped block emit from the
  // source. Fetches feeHistory on demand (so a static head doesn't
  // re-fetch it), bridges any clean gap from the prev tip, then
  // reduces with the most recent mempool snapshot.
  const handleBlock = async (block: BlockResult): Promise<void> => {
    const [feeHistory, historicalBlocks] = await Promise.all([
      fetchFeeHistoryEnabled
        ? source.getFeeHistory(20, [10, 25, 50, 75, 90])
        : Promise.resolve(null),
      bridgeGap(block),
    ])
    reduceAndPublish({ block, feeHistory, txPool: latestMempool }, historicalBlocks)
  }

  // Mempool-event handler. Caches the latest snapshot for the next
  // block reduce + powers `getMempoolSnapshot()` when retention is on.
  const handleMempool = (snapshot: NormalizedMempool): void => {
    latestMempool = snapshot
    if (retainMempool) {
      mempoolSnapshot = snapshot
    }
  }

  const attachToSource = (): void => {
    if (unsubBlocks !== null) return
    unsubBlocks = source.subscribeBlocks((b) => {
      void handleBlock(b)
    })
    unsubMempool = source.subscribeMempool(handleMempool)
    // Start the source's poll loop when we own it. This is gated on
    // attach (not on `oracle.start()`) so `pauseWhenIdle` truly
    // suppresses RPC traffic — no consumers means no polling. Source
    // start/stop is idempotent so subscribe → unsubscribe → subscribe
    // cycles are safe.
    if (ownsSource) source.start()
    // Note: no need to clear `staleTimer` here. The only path that
    // sets a non-null `staleTimer` is `scheduleIdleDetach` (called
    // when the last subscriber leaves), and that path leaves
    // `unsubBlocks !== null`. So a re-subscribe entering this
    // function early-returns at the `unsubBlocks !== null` guard
    // above before reaching this point. Every other path that
    // crosses an attach/detach boundary (timer-driven detach,
    // visibility-driven detach, oracle.stop, scheduleIdleDetach
    // with staleAfter <= 0) clears the timer in `detachFromSource`.
  }

  const detachFromSource = (): void => {
    if (unsubBlocks !== null) {
      unsubBlocks()
      unsubBlocks = null
    }
    if (unsubMempool !== null) {
      unsubMempool()
      unsubMempool = null
    }
    if (staleTimer !== null) {
      clearTimeout(staleTimer)
      staleTimer = null
    }
    // Stop the private source when we detach. External sources stay
    // running — other consumers may still need them.
    if (ownsSource) source.stop()
  }

  const scheduleIdleDetach = (): void => {
    if (staleAfter <= 0) {
      detachFromSource()
      return
    }
    if (staleTimer !== null) return
    staleTimer = setTimeout(() => {
      // detachFromSource already nullifies staleTimer; no need to
      // do it explicitly here.
      detachFromSource()
    }, staleAfter)
  }

  // Structural shape of the bits of `document` we use — kept narrow
  // so the package doesn't need the DOM lib in tsconfig (`lib: ES2020`).
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
        detachFromSource()
        return
      }
      // Tab became visible — re-attach if we have a reason to (no
      // subscriber gating, OR subscribers are present).
      if (!pauseWhenIdle || subscribers.size > 0) {
        attachToSource()
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
      // Subscriber + visibility gating: attach our subscribers to the
      // source only when there's a reason. Source.start() is driven
      // from inside `attachToSource()` (when ownsSource), so a
      // pauseWhenIdle oracle with no subscribers issues zero RPCs
      // beyond the one-time capability probe.
      if (pauseWhenHidden && isHidden()) return
      if (!pauseWhenIdle || subscribers.size > 0) {
        attachToSource()
      }
    },
    stop: () => {
      // detachFromSource() also stops the private source when we own
      // it — see attachToSource for the matching start. External
      // sources stay running for other consumers.
      detachFromSource()
      teardownVisibilityHandling()
      state = null
      mempoolSnapshot = null
      latestMempool = null
      started = false
    },
    getState: () => state,
    getMempoolSnapshot: () => mempoolSnapshot,
    // `pollOnce` forces a fresh reduce regardless of head-probe gating
    // or block dedup at the source layer. Goes through the source's
    // on-demand methods rather than `subscribeBlocks` because dedup
    // would swallow a same-head pollOnce and never fire the subscriber.
    pollOnce: async () => {
      const block = await source.getBlock('latest')
      if (!block) return null
      const [feeHistory, freshMempool, historicalBlocks] = await Promise.all([
        fetchFeeHistoryEnabled
          ? source.getFeeHistory(20, [10, 25, 50, 75, 90])
          : Promise.resolve(null),
        fetchMempoolEnabled
          ? source.getMempoolSnapshot()
          : Promise.resolve(null),
        bridgeGap(block),
      ])
      latestMempool = freshMempool
      if (retainMempool) {
        mempoolSnapshot = freshMempool
      }
      return reduceAndPublish(
        { block, feeHistory, txPool: freshMempool },
        historicalBlocks,
      )
    },
    subscribe: (cb) => {
      subscribers.add(cb)
      // 0 → 1 transition: re-attach to the source if subscriber-gating
      // had us detached.
      if (started && pauseWhenIdle && subscribers.size === 1) {
        if (!pauseWhenHidden || !isHidden()) {
          attachToSource()
        }
      }
      return () => {
        subscribers.delete(cb)
        // n → 0 transition: schedule detach (immediate or after
        // `staleAfter` window).
        if (started && pauseWhenIdle && subscribers.size === 0) {
          scheduleIdleDetach()
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
