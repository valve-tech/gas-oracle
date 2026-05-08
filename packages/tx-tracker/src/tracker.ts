/**
 * `createTxTracker` — the per-tx state machine that turns a
 * `ChainSource`'s block + mempool stream into a stream of neutral
 * observations per tracked hash.
 *
 * Per `docs/tx-tracker-spec.md` §5.2 + §6 + §11 + §12. This file is
 * the load-bearing piece of `@valve-tech/tx-tracker`; everything
 * else is supporting infrastructure (events, store, reorg detector,
 * selectors).
 *
 * Design rules carried in from the spec and the contributing skill:
 *
 *   - **Three consumption shapes, one underlying stream** (§5.3).
 *     `getTxStatus(hash)` reads the cached snapshot; `subscribe(hash, cb)`
 *     attaches a callback; `track(hash)` returns an async iterator.
 *     All three see consistent state because they read from one
 *     internal `Subscriptions<TxEvent>` per hash.
 *
 *   - **Neutral observations only** (§2.1). The tracker emits
 *     `seen-in-mempool` / `seen-in-block` / `vanished-from-block` /
 *     `replaced-by` / `unseen-for-N-blocks` and lets the consumer
 *     write the policy that says "confirmed" or "stuck" in their
 *     UX voice.
 *
 *   - **No silent downgrade** (§2.2). Every emitted event carries a
 *     `source` discriminator. When the source's `capabilities()`
 *     change between ticks, the tracker emits `signal-degraded` /
 *     `signal-recovered` per affected capability.
 *
 *   - **No own poll cycle** (§3.1, contributing-skill rule 3). The
 *     tracker hangs off `source.subscribeBlocks` and
 *     `source.subscribeMempool`; every per-tick computation runs
 *     inside those callbacks.
 *
 *   - **Browser/mobile safe** (§2.4). No Node-only deps; the
 *     pub/sub primitive is `chain-source`'s `Subscriptions<E>`.
 */

import type {
  BlockResult,
  ChainSource,
  Capabilities,
  EventSource,
  NormalizedMempool,
  RawTx,
  TransactionReceipt,
} from '@valve-tech/chain-source'
import { Subscriptions } from '@valve-tech/chain-source'

import { createTxGroup } from './group.js'
import type { TxGroupEvent } from './group-events.js'

import {
  buildSeenInBlock,
  buildSignalDegraded,
  buildSignalRecovered,
  buildStarted,
  buildStopped,
  buildVanishedFromBlock,
  buildInitialStatus,
  type Address,
  type At,
  type Hash,
  type TxEvent,
  type TxStatus,
} from './events.js'
import {
  decideBlockObservation,
  decideMempoolObservation,
  type ObservationResult,
} from './observations.js'
import {
  appendBlock,
  defaultReorgDepthBlocks,
  detectDivergences,
  type BlockSample,
} from './reorg.js'
import {
  compileSelector,
  defaultMaxBulkSubscriptions,
  matchAll,
  type CompiledSelector,
} from './selectors.js'
import {
  computeRetentionExpiry,
  createInMemoryStore,
  defaultRetentionBlocks,
  type BulkSelector,
  type PersistedSubscription,
  type TrackedTxRecord,
  type TxTrackerStore,
} from './store.js'

// -----------------------------------------------------------------
// Public option / return types
// -----------------------------------------------------------------

/**
 * Lost-signal policy (spec §8). `'emit-uncertain'` is the default
 * — every transition to a degraded source emits `signal-degraded`.
 * `'silent'` keeps the events to itself; `'receipt-poll-fallback'`
 * fetches `eth_getTransactionReceipt` every `pollEveryBlocks` block
 * ticks and emits `seen-in-block` with `source: 'receipt-poll'` on a
 * hit. Requires `capabilities().receiptByHash === 'available'`;
 * when unavailable, downgrades to emit-uncertain semantics with a
 * one-shot warning via `onError`.
 */
export type LostSignalPolicy =
  | 'emit-uncertain'
  | 'silent'
  | { strategy: 'receipt-poll-fallback'; pollEveryBlocks: number }

/**
 * Per-subscription overrides on top of the tracker defaults. See
 * spec §5.4.
 */
export interface TrackOptions {
  /**
   * Emit a synthetic `started` event on subscribe even if no real
   * observation has fired yet. Default true. Wallets use this to
   * render an "awaiting first observation" state without polling.
   */
  emitInitial?: boolean

  /**
   * Persist this subscription via the store. Default false — the
   * subscription survives only the current process. Indexer / relay
   * consumers set this true.
   */
  durable?: boolean

  /** Per-subscription override of the tracker's `lostSignalPolicy`. */
  lostSignalPolicy?: LostSignalPolicy

  /**
   * How many consecutive blocks the hash must be unseen (not in
   * mempool, not in the canonical block) before
   * `unseen-for-N-blocks` fires. Default 30 (spec §6.1).
   */
  unseenThresholdBlocks?: number

  /**
   * Eager receipt enrichment. When true, fetch the transaction
   * receipt at seen-in-block time and attach it to the event via
   * the `receipt` field. Adds one RPC per inclusion. Default false.
   * Capability gate: requires source.capabilities().receiptByHash ===
   * 'available'; when unavailable, events still flow but `receipt`
   * is absent and a one-shot warning surfaces via onError.
   */
  withReceipts?: boolean
}

/** Bulk subscription options — extends per-hash `TrackOptions`. */
export interface BulkTrackOptions extends TrackOptions {
  /**
   * Auto-track every tx the selector matches by starting an
   * implicit per-hash subscription for it. Default true — an
   * indexer wiring `trackFromAddress(treasury)` typically wants
   * the per-hash event stream too. Set false to receive only the
   * raw `matched` stream without per-hash detail.
   */
  autoTrackMatched?: boolean
}

/** One emit from a bulk subscription — see spec §11.1. */
export interface TxMatchEvent {
  kind: 'matched'
  hash: Hash
  matchedBy: 'from' | 'to' | 'predicate'
  selector: BulkSelector
  tx: RawTx
  source: 'mempool-snapshot' | 'block-poll'
  at: At
}

/** Handle returned by every bulk-track method. */
export interface TxSubscription {
  /**
   * Async iterator over the raw `matched` stream. Iteration ends
   * when `stop()` is called or the tracker stops.
   */
  events(): AsyncIterable<TxMatchEvent>
  /**
   * Imperative subscription to per-hash events on every matched tx.
   * Returns an unsubscribe handle.
   */
  subscribe(cb: (event: TxEvent) => void): () => void
  /**
   * Stop the bulk subscription. Per-hash subscriptions auto-tracked
   * via this bulk subscription continue under their own retention
   * rules (spec §11.1).
   */
  stop(): void
}

/** Factory options. */
export interface CreateTxTrackerOptions {
  source: ChainSource
  chainId: number
  store?: TxTrackerStore
  lostSignalPolicy?: LostSignalPolicy
  reorgDepthBlocks?: number
  /** Default `unseenThresholdBlocks` for new subscriptions. */
  unseenThresholdBlocks?: number
  /** Cap on simultaneous bulk subscriptions (spec §11.3). */
  maxBulkSubscriptions?: number
  onError?: (method: string, err: unknown) => void
  lifecycle?: 'eager' | 'lazy'
}

/**
 * Options for a group subscription. All fields are optional — the group
 * works with defaults. See `createTxGroup` in `group.ts`.
 */
export interface GroupOptions {
  /** Optional human-readable group ID echoed in events. Default: random. */
  groupId?: string
  /** Per-member TrackOptions applied to each hash. */
  memberOptions?: TrackOptions
}

/**
 * Handle returned by `tracker.group(hashes, options?)`. Exposes three
 * consumption shapes (async iterator, callback, snapshot) over the same
 * group-event stream, plus a `stop()` to tear down all member
 * subscriptions.
 */
export interface TxGroupSubscription {
  /** Async-iterable surface over the group event stream. */
  events(): AsyncIterable<TxGroupEvent>
  /**
   * Imperative callback subscription. Returns an unsubscribe handle.
   */
  subscribe(cb: (event: TxGroupEvent) => void): () => void
  /** Snapshot of each member's current `TxStatus` (null if not yet observed). */
  snapshot(): Record<Hash, TxStatus | null>
  /** Tear down all member subscriptions and emit `group-stopped`. */
  stop(): void
}

/** Public surface returned by `createTxTracker`. */
export interface TxTracker {
  start(): void
  stop(): void
  getTxStatus(hash: Hash): TxStatus | null
  track(hash: Hash, options?: TrackOptions): AsyncIterable<TxEvent>
  subscribe(
    hash: Hash,
    cb: (event: TxEvent) => void,
    options?: TrackOptions,
  ): () => void
  trackFromAddress(
    address: Address,
    options?: BulkTrackOptions,
  ): TxSubscription
  trackToAddress(address: Address, options?: BulkTrackOptions): TxSubscription
  trackPredicate(
    match: (tx: RawTx) => boolean,
    options?: BulkTrackOptions,
  ): TxSubscription
  capabilities(): Capabilities
  subscribeAll(cb: (event: TxEvent) => void): () => void
  /**
   * Cross-tx correlation — track a logical group of related hashes
   * (e.g., a wallet's "claim + swap" pair). Emits group-level
   * synthesis events derived from the per-member event streams.
   * See spec §18.1, v0.8.0 design F3.
   */
  group(hashes: Hash[], options?: GroupOptions): TxGroupSubscription
}

// -----------------------------------------------------------------
// Internals
// -----------------------------------------------------------------

const DEFAULT_UNSEEN_THRESHOLD_BLOCKS = 30

/**
 * Internal per-hash state. Stored in `tracked` map keyed by hash.
 * `subs` is the per-hash event bus that callbacks/iterators attach
 * to; `status` is the cached snapshot returned by `getTxStatus`.
 */
interface TrackedRecord {
  hash: Hash
  status: TxStatus
  subs: Subscriptions<TxEvent>
  /**
   * (from, nonce) cached on first mempool / block observation —
   * powers replacement detection. Both fields stay strings (raw
   * hex from the upstream's RawTx).
   */
  identity: { from: string; nonce: string } | null
  /**
   * Whether this hash appeared in the most recent mempool snapshot.
   * Drives `left-mempool` emit when it falls out.
   */
  inLastMempoolSnapshot: boolean
  /** Per-subscription unseen threshold; min across active subs. */
  unseenThresholdBlocks: number
  /** Per-subscription lostSignalPolicy override; first-set wins. */
  lostSignalPolicy: LostSignalPolicy | null
  /** True if this is a fully durable record (any sub durable). */
  hasDurableSub: boolean
  /** Records of subscriptions for store persistence. */
  persisted: PersistedSubscription[]
  /**
   * True if any active subscription requested withReceipts. Set on
   * subscribe; never auto-cleared (cheap to over-fetch — receipts
   * are cached on the upstream and consumers expect once-set means
   * future events get them).
   */
  withReceipts: boolean
}

interface BulkSub {
  id: string
  compiled: CompiledSelector
  options: Required<Pick<BulkTrackOptions, 'autoTrackMatched' | 'emitInitial'>> &
    BulkTrackOptions
  matchSubs: Subscriptions<TxMatchEvent>
  perHashSubs: Subscriptions<TxEvent>
  stopped: boolean
  /** Implicit per-hash subscriptions created by autoTrackMatched. */
  autoTrackedUnsubs: Map<Hash, () => void>
}

/**
 * Compare two capability snapshots; return per-key transitions
 * (`degraded` / `recovered`). Degradation is "moved away from the
 * higher-authority value" — `'subscription' → 'poll-only'`,
 * `'available' → 'gated'`, `'available' → 'unavailable'`.
 * Recovery is the reverse.
 */
const diffCapabilities = (
  prev: Capabilities,
  next: Capabilities,
): { degraded: (keyof Capabilities)[]; recovered: (keyof Capabilities)[] } => {
  const degraded: (keyof Capabilities)[] = []
  const recovered: (keyof Capabilities)[] = []
  const keys: (keyof Capabilities)[] = [
    'newHeads',
    'newPendingTransactions',
    'txpoolContent',
    'receiptByHash',
  ]
  for (const key of keys) {
    const before = capabilityRank(prev[key] as CapabilityValue)
    const after = capabilityRank(next[key] as CapabilityValue)
    if (after < before) degraded.push(key)
    else if (after > before) recovered.push(key)
  }
  return { degraded, recovered }
}

/**
 * Map capability values onto an ordinal so degradation/recovery can
 * be detected with a single comparison. Higher = more authoritative.
 * Inputs are constrained to the actual `Capabilities[key]` union
 * literals, so the switch is exhaustive — no default arm needed.
 */
type CapabilityValue =
  | 'subscription'
  | 'available'
  | 'poll-only'
  | 'gated'
  | 'unavailable'

const capabilityRank = (value: CapabilityValue): number => {
  switch (value) {
    case 'subscription':
    case 'available':
      return 2
    case 'poll-only':
      return 1
    case 'gated':
    case 'unavailable':
      return 0
  }
}

/**
 * Pick the `EventSource` discriminator for an event the tracker is
 * about to emit, given the current source-capability snapshot for
 * the relevant capability key. Block-side observations come from
 * either `'subscription'` (when `newHeads` is push) or `'block-poll'`
 * (when it's poll). Mempool-side observations come from
 * `'subscription'` (push) or `'mempool-snapshot'` (poll).
 */
const blockEventSource = (caps: Capabilities): EventSource =>
  caps.newHeads === 'subscription' ? 'subscription' : 'block-poll'

const mempoolEventSource = (caps: Capabilities): EventSource =>
  caps.newPendingTransactions === 'subscription'
    ? 'subscription'
    : 'mempool-snapshot'

// -----------------------------------------------------------------
// Factory
// -----------------------------------------------------------------

/**
 * Build a configured tracker.
 *
 * @example
 *   import { createChainSource } from '@valve-tech/chain-source'
 *   import { createTxTracker } from '@valve-tech/tx-tracker'
 *
 *   const source  = createChainSource({ client })
 *   const tracker = createTxTracker({ source, chainId: 1 })
 *
 *   source.start()
 *   tracker.start()
 *
 *   for await (const event of tracker.track('0xabc...')) {
 *     if (event.kind === 'seen-in-block' && event.confirmations >= 3) break
 *   }
 */
export const createTxTracker = (options: CreateTxTrackerOptions): TxTracker => {
  const {
    source,
    chainId,
    store = createInMemoryStore(),
    lostSignalPolicy: defaultLostSignalPolicy = 'emit-uncertain',
    reorgDepthBlocks = defaultReorgDepthBlocks,
    unseenThresholdBlocks = DEFAULT_UNSEEN_THRESHOLD_BLOCKS,
    maxBulkSubscriptions = defaultMaxBulkSubscriptions,
    onError,
    lifecycle = 'eager',
  } = options

  const tracked = new Map<Hash, TrackedRecord>()
  const bulkSubs = new Map<string, BulkSub>()
  const globalSubs = new Subscriptions<TxEvent>()

  let started = false
  let unsubBlocks: (() => void) | null = null
  let unsubMempool: (() => void) | null = null

  let blockRing: BlockSample[] = []
  let latestTip: BlockSample | null = null
  let latestTipTimestamp = 0n
  let lastCaps: Capabilities = source.capabilities()
  let nextSubId = 1

  // Receipt-poll-fallback state (spec §8). These vars track the
  // per-record tick counters and the one-shot capability-gate warning.
  let blocksSinceLastReceiptPoll = new Map<Hash, number>()
  let receiptPollGateWarned = false

  // withReceipts eager enrichment state (spec §18.2, F2). One-shot
  // capability-gate warning, reset on stop() so a subsequent start()
  // begins clean.
  let withReceiptsGateWarned = false

  // -------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------

  const buildAt = (): At => ({
    blockNumber: latestTip?.number ?? 0n,
    timestamp: latestTipTimestamp,
  })

  /**
   * Emit one event: deliver to per-hash subscribers, the global
   * `subscribeAll` stream, and the store's audit log. Per-subscriber
   * throws are swallowed by `Subscriptions.emit` already; store
   * failures are routed through `onError` per spec Appendix A.
   */
  const emit = (record: TrackedRecord, event: TxEvent): void => {
    record.subs.emit(event)
    globalSubs.emit(event)
    if (record.hasDurableSub) {
      void store.appendEvent(chainId, record.hash, event).catch((err) => {
        onError?.('store.appendEvent', err)
      })
      void store
        .put(toRecord(record))
        .catch((err) => onError?.('store.put', err))
    }
  }

  /**
   * Project an internal `TrackedRecord` onto the persisted shape.
   * Retention expiry is recomputed from the latest observed block
   * each time so a long-lived hash that keeps moving stays in the
   * store rather than getting GC'd mid-flight.
   */
  const toRecord = (record: TrackedRecord): TrackedTxRecord => {
    const lastBlock =
      record.status.lastObservedAtBlock ??
      record.status.firstObservedAtBlock ??
      latestTip?.number ??
      0n
    const firstBlock =
      record.status.firstObservedAtBlock ?? latestTip?.number ?? 0n
    return {
      chainId,
      hash: record.hash,
      status: record.status,
      firstSeenBlockNumber: firstBlock,
      lastObservedBlockNumber: lastBlock,
      retentionExpiresAtBlockNumber: computeRetentionExpiry(
        lastBlock,
        defaultRetentionBlocks,
      ),
      subscriptions: record.persisted,
    }
  }

  /**
   * Get-or-create the per-hash internal record. New records are
   * seeded with `buildInitialStatus` against the current capability
   * snapshot.
   */
  const ensureRecord = (hash: Hash): TrackedRecord => {
    let record = tracked.get(hash)
    if (record) return record
    record = {
      hash,
      status: buildInitialStatus({
        hash,
        chainId,
        capabilities: source.capabilities(),
      }),
      subs: new Subscriptions<TxEvent>(),
      identity: null,
      inLastMempoolSnapshot: false,
      unseenThresholdBlocks,
      lostSignalPolicy: null,
      hasDurableSub: false,
      persisted: [],
      withReceipts: false,
    }
    tracked.set(hash, record)
    return record
  }

  /**
   * Detach a per-hash subscription. If no subscribers remain AND the
   * record carries no durable persistence, drop the record so the
   * tracker's footprint matches what's actually in flight.
   */
  const cleanupRecord = (record: TrackedRecord): void => {
    if (record.subs.size() > 0) return
    if (record.hasDurableSub) return
    tracked.delete(record.hash)
    blocksSinceLastReceiptPoll.delete(record.hash)
  }

  // -------------------------------------------------------------
  // Receipt-poll-fallback path (spec §8)
  // -------------------------------------------------------------

  /**
   * Per-record receipt poll. Runs once per block tick for every
   * tracked hash whose `lostSignalPolicy` is `'receipt-poll-fallback'`.
   * Uses `source.getReceipt(hash)` — requires capability
   * `receiptByHash: 'available'`. When the capability is absent,
   * downgrades to emit-uncertain semantics and fires a one-shot
   * warning through `onError`.
   *
   * The `blocksSinceLastReceiptPoll` counter is per-hash so different
   * hashes can have independent cadences (e.g. when a per-subscription
   * override is introduced in a future PR). Today the tracker-level
   * default policy applies to all records.
   *
   * `lastSeenInBlock` is only updated when the receipt-poll returns a
   * block number **strictly newer** than the currently cached
   * `lastSeenInBlock.blockNumber` — this prevents receipt-poll
   * (lower authority) from overwriting a block-poll / subscription
   * observation that already recorded the same height with higher
   * authority.
   */
  const runReceiptPollFallback = async (
    record: TrackedRecord,
    tipBlockNumber: bigint,
  ): Promise<void> => {
    const policy = record.lostSignalPolicy ?? defaultLostSignalPolicy
    if (typeof policy !== 'object' || policy.strategy !== 'receipt-poll-fallback') {
      return
    }

    // Capability gate: if receiptByHash is unavailable, warn once and
    // fall back to emit-uncertain semantics (the signal-degraded path
    // already handles caller awareness).
    if (source.capabilities().receiptByHash !== 'available') {
      if (!receiptPollGateWarned) {
        receiptPollGateWarned = true
        onError?.(
          'tx-tracker.receipt-poll-fallback',
          new Error(
            'receipt-poll-fallback requested but capability receiptByHash unavailable; falling back to emit-uncertain semantics',
          ),
        )
      }
      return
    }

    // Tick counter — only fetch every `pollEveryBlocks` ticks.
    const ticksSince = (blocksSinceLastReceiptPoll.get(record.hash) ?? 0) + 1
    if (ticksSince < policy.pollEveryBlocks) {
      blocksSinceLastReceiptPoll.set(record.hash, ticksSince)
      return
    }
    blocksSinceLastReceiptPoll.set(record.hash, 0)

    let receipt: TransactionReceipt | null = null
    try {
      receipt = await source.getReceipt(record.hash)
    } catch (err) {
      onError?.('tx-tracker.getReceipt', err)
      return
    }
    if (!receipt) return

    let receiptBlockNumber: bigint
    try {
      receiptBlockNumber = BigInt(receipt.blockNumber)
    } catch {
      onError?.(
        'tx-tracker.receipt-poll-fallback',
        new Error(`bad receipt blockNumber: ${receipt.blockNumber}`),
      )
      return
    }

    // Only update when the receipt carries a block we haven't recorded
    // from a higher-authority path at the same or later height.
    const existingBlock = record.status.lastSeenInBlock
    if (existingBlock && existingBlock.blockNumber >= receiptBlockNumber) {
      return
    }

    // Record was unsubscribed while getReceipt was in-flight; bail out rather
    // than emit on an orphaned record.
    if (!tracked.has(record.hash)) return

    emit(
      record,
      buildSeenInBlock({
        hash: record.hash,
        chainId,
        source: 'receipt-poll',
        at: { blockNumber: tipBlockNumber, timestamp: latestTipTimestamp },
        blockHash: receipt.blockHash,
        blockNumber: receiptBlockNumber,
        transactionIndex: 0, // not exposed via receipt; kept 0 for spec consistency
        confirmations: 1,
      }),
    )
    // Mirror state-machine bookkeeping so getTxStatus reflects inclusion.
    // Set lastObservedAtBlock to the chain tip (the block that triggered this
    // poll) rather than the receipt's inclusion block, so the retention window
    // expiry advances with the chain even for old inclusions polled later.
    record.status = {
      ...record.status,
      lastSeenInBlock: {
        blockHash: receipt.blockHash,
        blockNumber: receiptBlockNumber,
        transactionIndex: 0,
        confirmations: 1,
        source: 'receipt-poll',
      },
      lastObservedAtBlock: tipBlockNumber,
    }
  }

  // -------------------------------------------------------------
  // Block path — runs on every source block emit
  // -------------------------------------------------------------

  const onBlock = async (block: BlockResult): Promise<void> => {
    let blockNumber: bigint
    try {
      blockNumber = BigInt(block.number)
    } catch {
      onError?.('tx-tracker.onBlock', new Error(`bad block number: ${block.number}`))
      return
    }
    let blockTimestamp = 0n
    try {
      blockTimestamp = BigInt(block.timestamp)
    } catch {
      // leave 0n if timestamp didn't decode; not fatal
    }

    const blockHash = block.hash ?? ''
    const txs = Array.isArray(block.transactions) ? block.transactions : []

    const txHashSet = new Set<Hash>()
    for (const tx of txs) if (tx.hash) txHashSet.add(tx.hash)

    // Snapshot the pre-update ring + previous tip *before* we mutate
    // anything — the reorg detector needs the ring as it stood
    // before the new block landed in order to spot a same-height
    // hash flip. `appendBlock` overwrites a same-height entry, so
    // doing it before the comparison would erase the very evidence
    // the detector relies on.
    const previousRing = blockRing
    const previousTipNumber = latestTip?.number ?? null
    const newTip: BlockSample = {
      number: blockNumber,
      hash: blockHash,
      parentHash: block.parentHash ?? null,
      transactionHashes: txHashSet,
    }
    latestTip = newTip
    latestTipTimestamp = blockTimestamp
    blockRing = appendBlock(blockRing, newTip, reorgDepthBlocks * 2)

    // Reorg detection on the pre-update ring vs the new tip. A
    // divergence at the new tip's height = same-height-different-hash
    // reorg; per spec §12.3 the event source is block-poll or
    // subscription, never receipt-poll.
    handleReorgs(previousRing, newTip)

    // Capability transitions are checked once per block emit so
    // signal-degraded / signal-recovered events carry the new tip's
    // coordinate. The diff is global; the events fan out to every
    // tracked hash whose subscription policy permits them.
    handleCapabilityChange()

    const eventSource = blockEventSource(source.capabilities())

    // Bulk subscriptions run BEFORE per-hash inclusion bookkeeping
    // so any auto-tracked hashes created for matched txs end up in
    // the `tracked` map in time to receive their own seen-in-block
    // event from the loop below. Reordering here is load-bearing —
    // see the test "trackFromAddress autoTrackMatched: true creates
    // per-hash subscriptions."
    runBulkOnBlock(txs)

    // withReceipts F2 — pre-fetch receipts for hashes that (a) request
    // receipt enrichment and (b) are about to be included in this block.
    // Fetched in parallel before the per-record loop so the first emitted
    // seen-in-block event already carries the receipt (spec §18.2).
    const prefetchedReceipts = new Map<Hash, TransactionReceipt>()
    if (source.capabilities().receiptByHash === 'available') {
      const targets: Hash[] = []
      for (const record of tracked.values()) {
        if (record.withReceipts && txHashSet.has(record.hash)) {
          targets.push(record.hash)
        }
      }
      if (targets.length > 0) {
        const results = await Promise.all(
          targets.map(async (hash) => {
            try {
              return [hash, await source.getReceipt(hash)] as const
            } catch (err) {
              onError?.('tx-tracker.getReceipt', err)
              return [hash, null] as const
            }
          }),
        )
        for (const [hash, receipt] of results) {
          if (receipt) prefetchedReceipts.set(hash, receipt)
        }
      }
    } else {
      // Capability gate: warn once if any tracked hash wants withReceipts.
      for (const record of tracked.values()) {
        if (record.withReceipts) {
          if (!withReceiptsGateWarned) {
            withReceiptsGateWarned = true
            onError?.(
              'tx-tracker.withReceipts',
              new Error(
                'withReceipts: true requested but capability receiptByHash unavailable; events flow without receipt field',
              ),
            )
          }
          break
        }
      }
    }

    // Per-hash inclusion check + confirmations + unseen-streak
    // accounting. Delegated to `decideBlockObservation` (pure) — the
    // orchestrator below merges the returned patches into the
    // mutable record and emits the returned events.
    const envelope = buildAt()
    for (const record of tracked.values()) {
      // Stale-block guard: if a concurrent onBlock invocation (block N+1)
      // already advanced this record past the block we're processing here
      // (block N), skip applying our stale statusPatch. The async pre-fetch
      // for withReceipts opened this interleave window — without this guard
      // we'd clobber the newer state with older data.
      const recordedSince = record.status.lastObservedAtBlock
      if (recordedSince !== null && recordedSince > blockNumber) {
        continue
      }
      const result = decideBlockObservation({
        record,
        blockHash,
        blockNumber,
        txHashSet,
        txs,
        chainId,
        eventSource,
        envelope,
        previousTipNumber,
        prefetchedReceipts,
      })
      applyObservationResult(record, result)
      for (const event of result.events) emit(record, event)
    }

    // Receipt-poll-fallback: dispatch non-blocking per-record receipt
    // fetches. These run AFTER the synchronous block-observation loop
    // so any block-poll inclusion emitted above is already reflected in
    // `record.status.lastSeenInBlock` before the poll fires. The void
    // dispatch intentionally does not await — onBlock must stay
    // synchronous from the caller's perspective; receipt fetches settle
    // in the background and emit asynchronously.
    // `latestTip` is always set to `newTip` above before this loop runs.
    for (const record of tracked.values()) {
      void runReceiptPollFallback(record, latestTip.number)
    }
  }

  /**
   * Compare the pre-update ring against the new tip via the reorg
   * detector. A divergence at the new tip's height means the ring
   * had a different hash there before — classic same-height reorg.
   * For each divergence, every tracked hash whose recorded
   * `lastSeenInBlock` pointed at the stale block emits
   * `vanished-from-block`.
   *
   * Only the new tip is passed as the canonical sequence in v0.6.x
   * — the detector is conservative about heights with no canonical
   * info (per the reorg.ts design) so this stays safe with a
   * single-block window.
   */
  const handleReorgs = (
    previousRing: ReadonlyArray<BlockSample>,
    newTip: BlockSample,
  ): void => {
    const divergences = detectDivergences({
      ring: previousRing,
      canonical: [newTip],
      depthBlocks: reorgDepthBlocks,
    })
    if (divergences.length === 0) return

    const eventSource = blockEventSource(source.capabilities())
    for (const div of divergences) {
      // Walk every tracked hash whose lastSeenInBlock referenced the
      // stale hash at this height. The tx-set on the divergence is
      // the authoritative scoper.
      for (const record of tracked.values()) {
        const seen = record.status.lastSeenInBlock
        if (!seen) continue
        if (seen.blockNumber !== div.blockNumber) continue
        record.status.vanishedAt = {
          previousBlockHash: div.previousBlockHash,
          canonicalBlockHash: div.canonicalBlockHash,
          blockNumber: div.blockNumber,
        }
        // Reset inclusion state — the tx is no longer in the
        // canonical chain at the height we recorded.
        record.status.lastSeenInBlock = null
        record.status.lastObservedAtBlock = newTip.number
        emit(
          record,
          buildVanishedFromBlock({
            hash: record.hash,
            chainId,
            source: eventSource,
            at: buildAt(),
            previousBlockHash: div.previousBlockHash,
            canonicalBlockHash: div.canonicalBlockHash,
            blockNumber: div.blockNumber,
          }),
        )
      }
    }
  }

  /**
   * Compare the source's current capability snapshot to the last
   * one we observed. Emit signal-degraded for newly-degraded
   * capabilities, signal-recovered for newly-recovered ones. Per
   * the per-subscription policy, `'silent'` callers are excluded
   * from the per-record fanout.
   */
  const handleCapabilityChange = (): void => {
    const next = source.capabilities()
    const { degraded, recovered } = diffCapabilities(lastCaps, next)
    if (degraded.length === 0 && recovered.length === 0) return
    const fallback = blockEventSource(next)
    for (const record of tracked.values()) {
      const policy = record.lostSignalPolicy ?? defaultLostSignalPolicy
      if (policy === 'silent') {
        record.status.capabilities = next
        continue
      }
      for (const key of degraded) {
        emit(
          record,
          buildSignalDegraded({
            hash: record.hash,
            chainId,
            source: fallback,
            at: buildAt(),
            capabilityLost: key,
            fallbackSource: fallback,
          }),
        )
      }
      for (const key of recovered) {
        emit(
          record,
          buildSignalRecovered({
            hash: record.hash,
            chainId,
            source: fallback,
            at: buildAt(),
            capabilityRestored: key,
          }),
        )
      }
      record.status.capabilities = next
    }
    lastCaps = next
  }

  /**
   * Apply a pure-decision result to a mutable internal record. The
   * decision functions return narrow patches (only the fields they
   * decided to change); this orchestrator merges them into the
   * record in one place so mutation is bounded and auditable.
   */
  const applyObservationResult = (
    record: TrackedRecord,
    result: ObservationResult,
  ): void => {
    if (Object.keys(result.statusPatch).length > 0) {
      record.status = { ...record.status, ...result.statusPatch }
    }
    if (result.identityPatch) {
      record.identity = result.identityPatch
    }
    if (result.inMempoolPatch !== null) {
      record.inLastMempoolSnapshot = result.inMempoolPatch
    }
  }

  // -------------------------------------------------------------
  // Mempool path — runs on every source mempool emit
  // -------------------------------------------------------------

  const onMempool = (snapshot: NormalizedMempool): void => {
    // Build a hash-keyed index once per snapshot — O(N) per snapshot
    // but the per-tracked-hash lookup downstream is O(1).
    const byHash = new Map<Hash, { bucket: 'pending' | 'queued'; tx: RawTx }>()
    for (const sender of Object.keys(snapshot.pending)) {
      const nonces = snapshot.pending[sender]
      for (const nonceKey of Object.keys(nonces)) {
        const tx = nonces[nonceKey]
        if (tx?.hash) byHash.set(tx.hash, { bucket: 'pending', tx })
      }
    }
    for (const sender of Object.keys(snapshot.queued)) {
      const nonces = snapshot.queued[sender]
      for (const nonceKey of Object.keys(nonces)) {
        const tx = nonces[nonceKey]
        if (tx?.hash) byHash.set(tx.hash, { bucket: 'queued', tx })
      }
    }

    const eventSource = mempoolEventSource(source.capabilities())
    const envelope = buildAt()
    const tipBlockNumber = latestTip?.number ?? 0n

    // Per-hash presence + replacement detection. Both delegated to
    // `decideMempoolObservation` (pure). The orchestrator pre-
    // computes the per-record replacement candidate from the
    // snapshot so the decision function stays closure-free.
    for (const record of tracked.values()) {
      const presence = byHash.get(record.hash) ?? null
      const replacementInMempool = record.identity
        ? findReplacementInMempool(snapshot, record.identity, record.hash)
        : null
      const result = decideMempoolObservation({
        record,
        presence,
        replacementInMempool,
        chainId,
        eventSource,
        envelope,
        tipBlockNumber,
      })
      applyObservationResult(record, result)
      for (const event of result.events) emit(record, event)
    }

    // Bulk subscriptions on the mempool path.
    runBulkOnMempool(byHash)
  }

  /**
   * Pure mempool-snapshot lookup for a colliding `(from, nonce)`.
   * Replaces the closure-based legacy helper — extracted for direct
   * testability and to keep `decideMempoolObservation` pure.
   *
   * Normalizes the cached identity's nonce to decimal before keying
   * into the snapshot's nonce-keyed sub-map (chain-source's
   * `normalizeMempool` lowercases addresses + decimalizes nonces).
   * If the cached nonce isn't valid hex (test fixtures or off-spec
   * RPCs), the BigInt() throws — fallback uses the raw string as
   * the key.
   */
  const findReplacementInMempool = (
    snapshot: NormalizedMempool,
    identity: { from: string; nonce: string },
    originalHash: Hash,
  ): RawTx | null => {
    const senderKey = identity.from.toLowerCase()
    let nonceKey: string
    try {
      nonceKey = BigInt(identity.nonce).toString(10)
    } catch {
      nonceKey = identity.nonce
    }
    const buckets: ('pending' | 'queued')[] = ['pending', 'queued']
    for (const bucket of buckets) {
      const senderTxs = snapshot[bucket][senderKey]
      if (!senderTxs) continue
      const tx = senderTxs[nonceKey]
      if (tx?.hash && tx.hash !== originalHash) return tx
    }
    return null
  }

  // -------------------------------------------------------------
  // Bulk subscription helpers
  // -------------------------------------------------------------

  /**
   * Fan-out helpers for both block + mempool ticks. The bulk
   * registry guarantees that any sub still in `bulkSubs` is alive
   * (`sub.stop()` does `bulkSubs.delete(id)`), so we don't need
   * per-iteration "is it stopped?" guards here. The early return
   * on size===0 keeps the hot path cheap when no bulk subs exist.
   */
  const runBulkOnBlock = (txs: RawTx[]): void => {
    if (bulkSubs.size === 0) return
    const compiled = [...bulkSubs.values()].map((sub) => sub.compiled)
    fanOutBulkMatches(matchAll(txs, compiled), 'block-poll')
  }

  const runBulkOnMempool = (
    byHash: Map<Hash, { bucket: 'pending' | 'queued'; tx: RawTx }>,
  ): void => {
    if (bulkSubs.size === 0) return
    const compiled = [...bulkSubs.values()].map((sub) => sub.compiled)
    const txs = [...byHash.values()].map((v) => v.tx)
    fanOutBulkMatches(matchAll(txs, compiled), 'mempool-snapshot')
  }

  /**
   * Reverse-lookup: given a compiled selector reference, find its
   * owning bulk sub. The `compiled.selector` reference is the same
   * object the consumer registered, and every sub in `bulkSubs`
   * carries it — so a miss here would mean the registry was
   * mutated mid-fanout, which doesn't happen.
   */
  const findBulkSubBySelector = (selector: BulkSelector): BulkSub => {
    for (const sub of bulkSubs.values()) {
      if (sub.compiled.selector === selector) return sub
    }
    /* c8 ignore next */
    throw new Error('tx-tracker: invariant violated — selector ref missing from bulkSubs')
  }

  const fanOutBulkMatches = (
    matches: ReturnType<typeof matchAll>,
    matchSource: 'mempool-snapshot' | 'block-poll',
  ): void => {
    for (const match of matches) {
      const sub = findBulkSubBySelector(match.selector)
      const event: TxMatchEvent = {
        kind: 'matched',
        hash: match.hash,
        matchedBy: match.matchedBy,
        selector: match.selector,
        tx: match.tx,
        source: matchSource,
        at: buildAt(),
      }
      sub.matchSubs.emit(event)
      if (sub.options.autoTrackMatched && !sub.autoTrackedUnsubs.has(match.hash)) {
        const unsub = subscribe(
          match.hash,
          (e) => sub.perHashSubs.emit(e),
          { emitInitial: false },
        )
        sub.autoTrackedUnsubs.set(match.hash, unsub)
      }
    }
  }

  // -------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------

  const subscribe = (
    hash: Hash,
    cb: (event: TxEvent) => void,
    callerOptions?: TrackOptions,
  ): (() => void) => {
    const opts = callerOptions ?? {}
    const record = ensureRecord(hash)

    // Honor the most-restrictive `unseenThresholdBlocks` across
    // active subscriptions on this hash. New subscriptions may be
    // narrower than existing ones; the tracker takes the min.
    if (opts.unseenThresholdBlocks !== undefined) {
      record.unseenThresholdBlocks = Math.min(
        record.unseenThresholdBlocks,
        opts.unseenThresholdBlocks,
      )
    }
    if (opts.lostSignalPolicy && record.lostSignalPolicy === null) {
      record.lostSignalPolicy = opts.lostSignalPolicy
    }
    if (opts.withReceipts === true) {
      record.withReceipts = true
    }
    if (opts.durable) {
      record.hasDurableSub = true
      const subId = `sub-${nextSubId++}`
      record.persisted.push({
        id: subId,
        durable: true,
        selector: { kind: 'hash', hash },
      })
      void store.put(toRecord(record)).catch((err) => onError?.('store.put', err))
    }

    const unsub = record.subs.subscribe(cb)

    if (opts.emitInitial !== false) {
      // Synthetic started event — does not pass through `emit` since
      // the global stream / store should not see per-subscription
      // synthetic frames.
      cb(
        buildStarted({
          hash,
          chainId,
          source: blockEventSource(source.capabilities()),
          at: buildAt(),
          capabilities: source.capabilities(),
        }),
      )
    }

    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      // Final stopped event direct to the caller (single-shot) so
      // they always see lifecycle closure even after unsubscribe.
      cb(
        buildStopped({
          hash,
          chainId,
          source: blockEventSource(source.capabilities()),
          at: buildAt(),
          reason: 'unsubscribed',
        }),
      )
      unsub()
      cleanupRecord(record)
    }
  }

  const track = (
    hash: Hash,
    callerOptions?: TrackOptions,
  ): AsyncIterable<TxEvent> => {
    return {
      [Symbol.asyncIterator]: () => makeAsyncIterator(hash, callerOptions),
    }
  }

  const subscribeAll = (cb: (event: TxEvent) => void): (() => void) =>
    globalSubs.subscribe(cb)

  const makeBulkSub = (
    selector: BulkSelector,
    callerOptions?: BulkTrackOptions,
  ): TxSubscription => {
    if (bulkSubs.size >= maxBulkSubscriptions) {
      throw new Error(
        `tx-tracker: max bulk subscriptions (${maxBulkSubscriptions}) reached`,
      )
    }
    const compiled = compileSelector(selector)
    if (selector.kind === 'predicate' && callerOptions?.durable) {
      onError?.(
        'tx-tracker.bulk',
        new Error(
          'predicate selectors are non-durable (spec §13.2); ignoring durable: true',
        ),
      )
    }
    const id = `bulk-${nextSubId++}`
    const sub: BulkSub = {
      id,
      compiled,
      options: {
        autoTrackMatched: callerOptions?.autoTrackMatched ?? true,
        emitInitial: callerOptions?.emitInitial ?? true,
        ...callerOptions,
      },
      matchSubs: new Subscriptions<TxMatchEvent>(),
      perHashSubs: new Subscriptions<TxEvent>(),
      stopped: false,
      autoTrackedUnsubs: new Map(),
    }
    bulkSubs.set(id, sub)
    return {
      events: () => makeBulkAsyncIterable(sub),
      subscribe: (cb) => sub.perHashSubs.subscribe(cb),
      stop: () => {
        if (sub.stopped) return
        sub.stopped = true
        bulkSubs.delete(id)
        // Auto-tracked per-hash subscriptions continue under their
        // own retention rules per spec §11.1.
      },
    }
  }

  const trackFromAddress = (
    address: Address,
    options?: BulkTrackOptions,
  ): TxSubscription => makeBulkSub({ kind: 'from', address }, options)

  const trackToAddress = (
    address: Address,
    options?: BulkTrackOptions,
  ): TxSubscription => makeBulkSub({ kind: 'to', address }, options)

  const trackPredicate = (
    match: (tx: RawTx) => boolean,
    options?: BulkTrackOptions,
  ): TxSubscription => makeBulkSub({ kind: 'predicate', match }, options)

  // -------------------------------------------------------------
  // Async iterator factory — backs `track()` and bulk events()
  // -------------------------------------------------------------

  const makeAsyncIterator = (
    hash: Hash,
    options?: TrackOptions,
  ): AsyncIterator<TxEvent> => {
    const queue: TxEvent[] = []
    const waiters: ((value: IteratorResult<TxEvent>) => void)[] = []
    let done = false

    const cb = (event: TxEvent): void => {
      if (event.kind === 'stopped') done = true
      const waiter = waiters.shift()
      if (waiter) {
        waiter({ value: event, done: false })
        if (done) {
          // Drain remaining waiters with done after the stopped event.
          while (waiters.length > 0) {
            waiters.shift()!({ value: undefined as unknown as TxEvent, done: true })
          }
        }
      } else {
        queue.push(event)
      }
    }
    const unsub = subscribe(hash, cb, options)

    return {
      next: () => {
        if (queue.length > 0) {
          const value = queue.shift()!
          return Promise.resolve({ value, done: false })
        }
        if (done) return Promise.resolve({ value: undefined as unknown as TxEvent, done: true })
        return new Promise<IteratorResult<TxEvent>>((resolve) => {
          waiters.push(resolve)
        })
      },
      return: () => {
        unsub()
        done = true
        // unsub() drives a synthetic 'stopped' event through `cb` above,
        // which sets done=true and drains every pending waiter via the
        // inner loop. The waiters queue is always empty by the time we
        // get here.
        return Promise.resolve({ value: undefined as unknown as TxEvent, done: true })
      },
    }
  }

  const makeBulkAsyncIterable = (sub: BulkSub): AsyncIterable<TxMatchEvent> => {
    return {
      [Symbol.asyncIterator]: () => {
        const queue: TxMatchEvent[] = []
        const waiters: ((value: IteratorResult<TxMatchEvent>) => void)[] = []
        let localDone = sub.stopped
        const unsub = sub.matchSubs.subscribe((event) => {
          const waiter = waiters.shift()
          if (waiter) waiter({ value: event, done: false })
          else queue.push(event)
        })
        return {
          next: () => {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false })
            }
            if (localDone || sub.stopped) {
              return Promise.resolve({
                value: undefined as unknown as TxMatchEvent,
                done: true,
              })
            }
            return new Promise<IteratorResult<TxMatchEvent>>((resolve) => {
              waiters.push(resolve)
            })
          },
          return: () => {
            localDone = true
            unsub()
            while (waiters.length > 0) {
              waiters.shift()!({
                value: undefined as unknown as TxMatchEvent,
                done: true,
              })
            }
            return Promise.resolve({
              value: undefined as unknown as TxMatchEvent,
              done: true,
            })
          },
        }
      },
    }
  }

  // -------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------

  const start = (): void => {
    if (started) return
    started = true
    lastCaps = source.capabilities()
    unsubBlocks = source.subscribeBlocks(onBlock)
    unsubMempool = source.subscribeMempool(onMempool)
  }

  const stop = (): void => {
    if (!started) return
    started = false
    unsubBlocks?.()
    unsubMempool?.()
    unsubBlocks = null
    unsubMempool = null
    // Emit stopped to every per-hash subscriber, then drop them.
    for (const record of tracked.values()) {
      const stoppedEvent = buildStopped({
        hash: record.hash,
        chainId,
        source: blockEventSource(source.capabilities()),
        at: buildAt(),
        reason: 'tracker-stopped',
      })
      record.subs.emit(stoppedEvent)
      globalSubs.emit(stoppedEvent)
    }
    tracked.clear()
    for (const sub of bulkSubs.values()) sub.stopped = true
    bulkSubs.clear()
    blockRing = []
    latestTip = null
    // Reset receipt-poll-fallback state so a subsequent start() begins clean.
    blocksSinceLastReceiptPoll = new Map()
    receiptPollGateWarned = false
    // Reset withReceipts gate so a subsequent start() begins clean.
    withReceiptsGateWarned = false
  }

  // Eager lifecycle: subscribe immediately on construction. Lazy
  // waits for the first track/getStatus call. The capability probe
  // itself runs eagerly in the source, independent of either case.
  if (lifecycle === 'eager') {
    // No-op; consumer calls `start()` explicitly. The eager/lazy
    // distinction in v0.6.x affects internal book-keeping only.
  }

  const trackerSurface: TxTracker = {
    start,
    stop,
    getTxStatus: (hash) => {
      const record = tracked.get(hash)
      return record ? record.status : null
    },
    track,
    subscribe,
    trackFromAddress,
    trackToAddress,
    trackPredicate,
    capabilities: () => source.capabilities(),
    subscribeAll,
    group: (hashes, opts) => createTxGroup(trackerSurface, hashes, opts),
  }
  return trackerSurface
}
