/**
 * Per-record decision functions — the **pure** logic that turns one
 * upstream observation (a block or a mempool snapshot) plus one
 * tracked record's current state into the events that should be
 * emitted and the state patch the orchestrator should apply.
 *
 * These functions are extracted from `tracker.ts`'s `onBlock` /
 * `onMempool` so each branch of the per-record state machine is
 * testable with literal fixture inputs — no stub source, no async
 * orchestration, no shared mutable closure. This is the same
 * primitive-vs-orchestrator split that `oracle.ts` (`reducePollInputs`
 * pure / poll loop stateful) and `chain-source` (math pure / source
 * stateful) already follow.
 *
 * Inputs are immutable; outputs are immutable. The caller in
 * `tracker.ts` applies the returned `statusPatch` and `identityPatch`
 * to its mutable `TrackedRecord`, then emits the returned `events`
 * via its event-bus + store-audit-log machinery.
 */

import type { EventSource, RawTx, TransactionReceipt } from '@valve-tech/chain-source'

import {
  buildConfirmedTerminal,
  buildLeftMempool,
  buildReplacedBy,
  buildSeenInBlock,
  buildSeenInMempool,
  buildUnseenForNBlocks,
  type At,
  type Hash,
  type TxEvent,
  type TxStatus,
} from './events.js'

/**
 * Read-only projection of `TrackedRecord` that the decision functions
 * consume. The orchestrator passes its mutable record through this
 * shape so the pure layer cannot accidentally mutate state.
 */
export interface ReadonlyTrackedRecord {
  hash: Hash
  status: TxStatus
  identity: { from: string; nonce: string } | null
  inLastMempoolSnapshot: boolean
  unseenThresholdBlocks: number
}

/**
 * Cached `(from, nonce)` identity of the tracked tx. Used for
 * replacement detection.
 */
export interface IdentityPatch {
  from: string
  nonce: string
}

/**
 * Result of a decision function: events to emit and patches to apply
 * to the tracked record. The patch shapes are deliberately narrow —
 * only the fields the function decided to change. The orchestrator
 * merges them into its mutable record.
 */
export interface ObservationResult {
  events: TxEvent[]
  statusPatch: Partial<TxStatus>
  identityPatch: IdentityPatch | null
  /** Set when the per-mempool-tick "in-snapshot?" flag should change. */
  inMempoolPatch: boolean | null
}

const EMPTY_RESULT: ObservationResult = {
  events: [],
  statusPatch: {},
  identityPatch: null,
  inMempoolPatch: null,
}

// -------------------------------------------------------------
// Block-side decision
// -------------------------------------------------------------

/**
 * Inputs to `decideBlockObservation`. The orchestrator builds a
 * `txHashSet` once per block and passes it for O(1) "did this hash
 * appear?" lookups across every tracked record.
 */
export interface BlockObservationInput {
  record: ReadonlyTrackedRecord
  blockHash: Hash
  blockNumber: bigint
  txHashSet: ReadonlySet<Hash>
  txs: ReadonlyArray<RawTx>
  chainId: number
  eventSource: EventSource
  envelope: At
  /**
   * The previous canonical tip's block number, or `null` if this is
   * the first block the tracker has seen. Used to gate the
   * "confirmation bump" path — we don't bump confirmations on the
   * very first block we observe.
   */
  previousTipNumber: bigint | null
  /**
   * Pre-fetched receipts for hashes whose `withReceipts` flag is set.
   * When a hash appears in this map, the receipt is attached to the
   * `seen-in-block` event. Omitted or empty means no enrichment. This
   * is the sole path for F2 eager receipt attachment (spec §18.2) —
   * the orchestrator fetches and populates this map before calling
   * `decideBlockObservation`, so the first emitted event carries the
   * receipt without a follow-up re-emit.
   */
  prefetchedReceipts?: ReadonlyMap<Hash, TransactionReceipt>
  /**
   * Threshold for the mined-and-confirmed terminal transition. When
   * non-null and the record's confirmations reach this value, the
   * record is marked terminal (anchored on the current block, same
   * pattern as the other terminal arms) and `confirmed-terminal`
   * fires exactly once. `null` preserves the v0.14 behavior of never
   * setting terminal via the mined path.
   */
  confirmationsForTerminal: number | null
}

/**
 * Per-record decision for one new canonical block. Returns the events
 * to emit and the state patch to apply. Mutually-exclusive paths,
 * evaluated in order:
 *
 *   1. Hash is in this block → fresh inclusion (emit `seen-in-block`
 *      with `confirmations: 1`) OR same-block re-observation (no
 *      emit; `lastSeenInBlock` is already current).
 *   2. Hash NOT in this block but was previously included → bump
 *      `confirmations` on the cached observation, emit a fresh
 *      `seen-in-block` carrying the new count.
 *   3. Hash NOT in this block, no prior inclusion, but identity is
 *      cached AND a different hash with the same `(from, nonce)` is
 *      in this block → emit `replaced-by` with the replacement's
 *      block number.
 *   4. Truly unseen → bump the unseen-block streak; emit
 *      `unseen-for-N-blocks` when the streak crosses the
 *      subscription's threshold. Does NOT emit on the first block
 *      after subscription (no `firstObservedAtBlock` yet).
 */
export const decideBlockObservation = (
  input: BlockObservationInput,
): ObservationResult => {
  const {
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
    confirmationsForTerminal,
  } = input

  // Helper for the mined-confirmed terminal transition (v0.15+).
  // Returns true when the current confirmations reach the configured
  // threshold AND the record hasn't already gone terminal via any
  // other path. The check is symmetric in Paths 1 + 2 since both
  // produce a fresh `confirmations` value on this tick.
  const reachedConfirmedTerminal = (confirmations: number): boolean =>
    confirmationsForTerminal != null &&
    confirmations >= confirmationsForTerminal &&
    record.status.terminalAtBlockNumber == null

  const wasSeenInThisBlock = txHashSet.has(record.hash)

  if (wasSeenInThisBlock) {
    const tx = txs.find((t) => t.hash === record.hash)
    if (!tx) {
      // Defensive: hash was in the set but the find missed. Should
      // be unreachable since the set is built from the same tx list.
      return EMPTY_RESULT
    }
    const transactionIndex = txs.indexOf(tx)
    const isFreshInclusion =
      record.status.lastSeenInBlock?.blockHash !== blockHash
    const confirmations = isFreshInclusion
      ? 1
      : record.status.lastSeenInBlock!.confirmations
    const lastSeenInBlock = {
      blockHash,
      blockNumber,
      transactionIndex,
      confirmations,
      source: eventSource,
    }
    const receipt = isFreshInclusion
      ? prefetchedReceipts?.get(record.hash)
      : undefined
    const terminalNow = reachedConfirmedTerminal(confirmations)
    const events: TxEvent[] = [
      ...(isFreshInclusion
        ? [
            buildSeenInBlock({
              hash: record.hash,
              chainId,
              source: eventSource,
              at: envelope,
              blockHash,
              blockNumber,
              transactionIndex,
              confirmations,
              ...(receipt !== undefined ? { receipt } : {}),
            }),
          ]
        : []),
      ...(terminalNow
        ? [
            buildConfirmedTerminal({
              hash: record.hash,
              chainId,
              source: eventSource,
              at: envelope,
              confirmations,
            }),
          ]
        : []),
    ]
    return {
      events,
      statusPatch: {
        lastSeenInBlock,
        unseenStreak: 0,
        firstObservedAtBlock: record.status.firstObservedAtBlock ?? blockNumber,
        lastObservedAtBlock: blockNumber,
        ...(terminalNow ? { terminalAtBlockNumber: blockNumber } : {}),
      },
      identityPatch: cacheIdentity(record.identity, tx),
      inMempoolPatch: null,
    }
  }

  // Path 2: not in this block, but previously observed → confirmation bump
  if (record.status.lastSeenInBlock && previousTipNumber !== null) {
    const bumped = record.status.lastSeenInBlock.confirmations + 1
    const updated = {
      ...record.status.lastSeenInBlock,
      confirmations: bumped,
    }
    const terminalNow = reachedConfirmedTerminal(bumped)
    return {
      events: [
        buildSeenInBlock({
          hash: record.hash,
          chainId,
          source: eventSource,
          at: envelope,
          blockHash: updated.blockHash,
          blockNumber: updated.blockNumber,
          transactionIndex: updated.transactionIndex,
          confirmations: bumped,
        }),
        ...(terminalNow
          ? [
              buildConfirmedTerminal({
                hash: record.hash,
                chainId,
                source: eventSource,
                at: envelope,
                confirmations: bumped,
              }),
            ]
          : []),
      ],
      statusPatch: {
        lastSeenInBlock: updated,
        lastObservedAtBlock: blockNumber,
        ...(terminalNow ? { terminalAtBlockNumber: blockNumber } : {}),
      },
      identityPatch: null,
      inMempoolPatch: null,
    }
  }

  // Path 3: replacement detection. When the mempool path already
  // detected the same replacement (status.replacedBy.hash matches),
  // patch status with the now-known blockNumber but do NOT re-fire
  // `replaced-by` — the consumer already received the event from
  // the mempool side and the replacement is one logical event.
  // Mirrors the `!record.status.replacedBy` gate the mempool path
  // uses to avoid duplicate emits in the other direction.
  if (record.identity) {
    const replacement = findReplacementInBlock(record.identity, record.hash, txs)
    if (replacement && replacement.hash) {
      const isNewReplacement =
        record.status.replacedBy?.hash !== replacement.hash
      return {
        events: isNewReplacement
          ? [
              buildReplacedBy({
                hash: record.hash,
                chainId,
                source: eventSource,
                at: envelope,
                replacementHash: replacement.hash,
                replacementBlockNumber: blockNumber,
              }),
            ]
          : [],
        statusPatch: {
          replacedBy: { hash: replacement.hash, blockNumber },
          lastObservedAtBlock: blockNumber,
          // Terminal: replacement included on-chain. Retention
          // countdown starts from this block (audit #2).
          terminalAtBlockNumber:
            record.status.terminalAtBlockNumber ?? blockNumber,
        },
        identityPatch: null,
        inMempoolPatch: null,
      }
    }
  }

  // Path 4: truly unseen — only counts when there's a prior
  // observation to count from. `== null` (loose) covers both null
  // and a missing field on a legacy persisted record (same posture
  // as the v0.11.1 audit fixes elsewhere in this file).
  if (record.status.firstObservedAtBlock == null) {
    return EMPTY_RESULT
  }

  // `?? 0` defends against legacy data where `unseenStreak` could
  // be undefined; without it, `undefined + 1 === NaN` and the patch
  // below would write `unseenStreak: NaN` permanently. Field has
  // been present since v0.3.x so no live trigger today, but the
  // hazard class is the same as the v0.11.1 root cause.
  const nextStreak = (record.status.unseenStreak ?? 0) + 1
  const reachedTerminal = nextStreak === record.unseenThresholdBlocks
  const events: TxEvent[] = reachedTerminal
    ? [
        buildUnseenForNBlocks({
          hash: record.hash,
          chainId,
          source: eventSource,
          at: envelope,
          blocks: nextStreak,
        }),
      ]
    : []
  return {
    events,
    statusPatch: {
      unseenStreak: nextStreak,
      // Terminal: unseen-for-N-blocks emitted at this block.
      // Retention countdown starts here (audit #2). `!= null`
      // (loose) so a legacy persisted record (≤0.10) whose
      // `terminalAtBlockNumber` is absent (undefined) also gets
      // backfilled when it reaches terminal — same posture as
      // tracker.ts's retention guard.
      ...(reachedTerminal && record.status.terminalAtBlockNumber == null
        ? { terminalAtBlockNumber: blockNumber }
        : {}),
    },
    identityPatch: null,
    inMempoolPatch: null,
  }
}

// -------------------------------------------------------------
// Mempool-side decision
// -------------------------------------------------------------

/**
 * Inputs to `decideMempoolObservation`. The orchestrator builds the
 * hash-keyed snapshot index once per mempool tick.
 */
export interface MempoolObservationInput {
  record: ReadonlyTrackedRecord
  presence: { bucket: 'pending' | 'queued'; tx: RawTx } | null
  /**
   * The replacement candidate found in the snapshot for this record's
   * `(from, nonce)` identity, or `null` if none. Computed by the
   * orchestrator once per record so this function stays pure on
   * inputs (no closure over the snapshot).
   */
  replacementInMempool: RawTx | null
  chainId: number
  eventSource: EventSource
  envelope: At
  /**
   * The current canonical-tip block number the orchestrator is using
   * for `firstObservedAtBlock` / `lastObservedAtBlock` book-keeping.
   * Falls back to `0n` when no tip has been observed yet.
   */
  tipBlockNumber: bigint
}

/**
 * Per-record decision for one mempool snapshot. Three independent
 * outputs that may all fire on the same call:
 *
 *   - **Presence transition** — emit `seen-in-mempool` on first
 *     observation or bucket change; emit `left-mempool` when a
 *     previously-seen hash is absent from this snapshot.
 *   - **Replacement** — emit `replaced-by` (with `null` block) when
 *     the orchestrator's pre-computed `replacementInMempool` is set
 *     AND the record hasn't already recorded a replacement.
 */
export const decideMempoolObservation = (
  input: MempoolObservationInput,
): ObservationResult => {
  const {
    record,
    presence,
    replacementInMempool,
    chainId,
    eventSource,
    envelope,
    tipBlockNumber,
  } = input

  const events: TxEvent[] = []
  let statusPatch: Partial<TxStatus> = {}
  let identityPatch: IdentityPatch | null = null
  let inMempoolPatch: boolean | null = null

  if (presence) {
    identityPatch = cacheIdentity(record.identity, presence.tx)
    const isFreshOrBucketChange =
      !record.inLastMempoolSnapshot ||
      record.status.lastSeenInMempool?.bucket !== presence.bucket
    statusPatch = {
      lastSeenInMempool: {
        bucket: presence.bucket,
        tx: presence.tx,
        at: envelope,
        source: eventSource,
      },
      unseenStreak: 0,
      firstObservedAtBlock:
        record.status.firstObservedAtBlock ?? tipBlockNumber,
      lastObservedAtBlock: tipBlockNumber,
    }
    inMempoolPatch = true
    if (isFreshOrBucketChange) {
      events.push(
        buildSeenInMempool({
          hash: record.hash,
          chainId,
          source: eventSource,
          at: envelope,
          bucket: presence.bucket,
          tx: presence.tx,
        }),
      )
    }
  } else if (record.inLastMempoolSnapshot) {
    inMempoolPatch = false
    events.push(
      buildLeftMempool({
        hash: record.hash,
        chainId,
        source: eventSource,
        at: envelope,
      }),
    )
  }

  // Replacement detection runs independently. The orchestrator skips
  // it when the record already carries a replacement; we mirror that
  // here so the function is self-contained.
  if (
    record.identity &&
    !record.status.replacedBy &&
    replacementInMempool &&
    replacementInMempool.hash &&
    replacementInMempool.hash !== record.hash
  ) {
    statusPatch = {
      ...statusPatch,
      replacedBy: { hash: replacementInMempool.hash, blockNumber: null },
      // Terminal: replacement seen in mempool. Retention countdown
      // starts from the current poll's block (audit #2). The block
      // path may later patch this with the replacement's inclusion
      // block, but the terminal anchor stays at the first
      // observation. `!= null` (loose) so a legacy persisted record
      // whose `terminalAtBlockNumber` is absent (undefined) also
      // gets backfilled — same posture as tracker.ts's retention
      // guard.
      ...(record.status.terminalAtBlockNumber == null
        ? { terminalAtBlockNumber: envelope.blockNumber }
        : {}),
    }
    events.push(
      buildReplacedBy({
        hash: record.hash,
        chainId,
        source: eventSource,
        at: envelope,
        replacementHash: replacementInMempool.hash,
        replacementBlockNumber: null,
      }),
    )
  }

  return { events, statusPatch, identityPatch, inMempoolPatch }
}

// -------------------------------------------------------------
// Helpers (also pure)
// -------------------------------------------------------------

/**
 * Find a tx in `txs` whose `(from, nonce)` matches `identity` but
 * whose hash differs from `originalHash` — the replacement candidate
 * for the original tracked tx. Compares senders case-insensitively
 * since upstreams disagree on checksum form.
 */
export const findReplacementInBlock = (
  identity: { from: string; nonce: string },
  originalHash: Hash,
  txs: ReadonlyArray<RawTx>,
): RawTx | null => {
  const targetFrom = identity.from.toLowerCase()
  for (const tx of txs) {
    if (tx.from?.toLowerCase() !== targetFrom) continue
    if (tx.nonce !== identity.nonce) continue
    if (!tx.hash) continue
    if (tx.hash === originalHash) continue
    return tx
  }
  return null
}

/**
 * Cache the tx's `(from, nonce)` as the record's identity if it's
 * not already cached AND the tx carries both fields. Returns the
 * patch to apply (or `null` when no change).
 */
export const cacheIdentity = (
  current: { from: string; nonce: string } | null,
  tx: RawTx,
): IdentityPatch | null => {
  if (current) return null
  if (!tx.from || !tx.nonce) return null
  return { from: tx.from, nonce: tx.nonce }
}
