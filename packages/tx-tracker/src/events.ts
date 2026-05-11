/**
 * `TxEvent` — the discriminated union of every observation the
 * tracker emits, plus payload builders that guarantee every event
 * carries a complete envelope.
 *
 * Per `docs/tx-tracker-spec.md` §6, this taxonomy is the contract
 * between the tracker and every consumer. Naming is **strictly
 * neutral** (§2.1): `seen-in-mempool` not `pending`, `seen-in-block`
 * not `mined`, `vanished-from-block` not `reorged`. The tracker
 * publishes facts; the consumer writes the policy on top.
 *
 * Every event variant extends a common `Envelope` carrying the
 * tracked `hash`, the `chainId`, the `source` discriminator (per
 * §2.2 — never silently downgrade) and the `at` block coordinate
 * the observation was made at. Builders here produce that envelope
 * once so the state machine in `tracker.ts` cannot accidentally
 * publish a partial event.
 *
 * No I/O, no wall-clock, no mutation — pure data shape + pure
 * builders. Browser/mobile safe (§2.4).
 */

import type { Capabilities, EventSource, RawTx, TransactionReceipt } from '@valve-tech/chain-source'

/**
 * Hash type carried on every event. The chain-source layer keeps
 * hashes as plain `string` rather than viem's `Hash` brand to stay
 * permissive at the JSON boundary; tx-tracker mirrors that posture
 * — every consumer can `as Hash` at the seam if they need the
 * branded form.
 */
export type Hash = string

/**
 * EVM address. Same posture as `Hash` — plain `string` so consumers
 * who normalize to lowercase or to checksum form don't trip a brand
 * check at the boundary.
 */
export type Address = string

/**
 * Block coordinate the observation was made at. `blockNumber` is the
 * canonical-tip number when the observation landed; `timestamp` is
 * the tip block's timestamp (seconds since epoch, same units the
 * EVM exposes). Both `bigint` per the toolkit's wire-format rule
 * (§2.5).
 */
export interface At {
  blockNumber: bigint
  timestamp: bigint
}

/**
 * Common envelope on every event. The state machine builds this once
 * per emit and merges it into the variant-specific payload below.
 */
export interface Envelope {
  hash: Hash
  chainId: number
  source: EventSource
  at: At
}

/**
 * Per-variant payload shapes. Consumers narrow on `event.kind` to
 * access variant-specific fields. The eslint config disallows TS
 * namespaces, so each variant is a top-level interface and the
 * `TxEvent` union below sums them.
 */

/**
 * Synthetic first event of a subscription when `emitInitial: true`
 * (the default). Carries the capability snapshot at subscribe time
 * so consumers can decide their fallback posture without a separate
 * call.
 */
export interface TxEventStarted extends Envelope {
  kind: 'started'
  capabilities: Capabilities
}

/**
 * Tracked hash was observed in the upstream's mempool snapshot or
 * pushed via `eth_subscribe('newPendingTransactions')`. `bucket`
 * disambiguates `txpool_content`'s pending-vs-queued split.
 */
export interface TxEventSeenInMempool extends Envelope {
  kind: 'seen-in-mempool'
  bucket: 'pending' | 'queued'
  tx: RawTx
}

/**
 * Tracked hash is no longer in the mempool snapshot. The tx may
 * have been mined, replaced, or evicted by the upstream node;
 * subsequent `seen-in-block` / `replaced-by` / `unseen-for-N-blocks`
 * disambiguates which of those happened.
 */
export interface TxEventLeftMempool extends Envelope {
  kind: 'left-mempool'
}

/**
 * Tracked hash was found in the canonical block at
 * `blockNumber` / `blockHash`, at index `transactionIndex`.
 * `confirmations` counts blocks observed since this inclusion
 * inclusive of the inclusion block itself (so the first
 * inclusion event has `confirmations: 1`).
 *
 * `receipt` is present iff the subscription set `withReceipts: true`.
 * Adds one RPC per inclusion (spec §18.2, v0.8.0 design F2).
 */
export interface TxEventSeenInBlock extends Envelope {
  kind: 'seen-in-block'
  blockHash: Hash
  blockNumber: bigint
  transactionIndex: number
  confirmations: number
  /**
   * Transaction receipt — present iff the subscription set
   * `withReceipts: true`. Adds one RPC per inclusion (spec §18.2,
   * v0.8.0 design F2).
   */
  receipt?: TransactionReceipt
}

/**
 * Tx was previously seen at block `blockNumber` with hash
 * `previousBlockHash`, but the canonical block at the same height
 * now has `canonicalBlockHash` and the tracked tx is not in its
 * `transactions`. Reorg.
 *
 * Per spec §12.3, this event never carries
 * `source: 'receipt-poll'` — receipt-poll cannot detect a reorg
 * because most providers happily return a receipt for a tx in a
 * no-longer-canonical block.
 */
export interface TxEventVanishedFromBlock extends Envelope {
  kind: 'vanished-from-block'
  previousBlockHash: Hash
  canonicalBlockHash: Hash
  blockNumber: bigint
}

/**
 * A different hash with the same `(from, nonce)` pair was either
 * seen in the mempool or mined. `replacementBlockNumber` is `null`
 * when the replacement was only observed in the mempool; it
 * carries the mined block's number when the replacement reached
 * inclusion before the original.
 */
export interface TxEventReplacedBy extends Envelope {
  kind: 'replaced-by'
  replacementHash: Hash
  replacementBlockNumber: bigint | null
}

/**
 * Tracked hash has not been in the mempool nor in any polled
 * block for `blocks` consecutive observations. Threshold is
 * configurable per subscription (`unseenThresholdBlocks`,
 * default 30 — see `tracker.ts`). Consumer interprets as
 * "likely dropped" / "stuck" / "rejected" in their own UX.
 */
export interface TxEventUnseenForNBlocks extends Envelope {
  kind: 'unseen-for-N-blocks'
  blocks: number
}

/**
 * A capability the tracker had been relying on for this hash is
 * no longer authoritative — typically because the WS subscription
 * dropped or `txpool_content` was newly gated. Tracking continues
 * via `fallbackSource`; the consumer's interpretation of subsequent
 * events should weigh that lower authority.
 */
export interface TxEventSignalDegraded extends Envelope {
  kind: 'signal-degraded'
  capabilityLost: keyof Capabilities
  fallbackSource: EventSource
}

/**
 * A previously-degraded capability is back. Fired after a
 * matching `signal-degraded` only.
 */
export interface TxEventSignalRecovered extends Envelope {
  kind: 'signal-recovered'
  capabilityRestored: keyof Capabilities
}

/**
 * Subscription teardown — fires once per subscription. Always the
 * final event in the stream for that subscription. `reason`
 * disambiguates which lifecycle path closed the iterator:
 *
 * - `'unsubscribed'`: consumer called the returned unsubscribe
 *   handle (or `break`'d an async iterator).
 * - `'retention-expired'`: store's retention window elapsed past
 *   the last terminal observation; the record was GC'd.
 * - `'tracker-stopped'`: `tracker.stop()` was called.
 */
export interface TxEventStopped extends Envelope {
  kind: 'stopped'
  reason: 'unsubscribed' | 'retention-expired' | 'tracker-stopped'
}

/**
 * Discriminated union of every event variant. Narrow on `kind` to
 * access variant-specific fields.
 */
export type TxEvent =
  | TxEventStarted
  | TxEventSeenInMempool
  | TxEventLeftMempool
  | TxEventSeenInBlock
  | TxEventVanishedFromBlock
  | TxEventReplacedBy
  | TxEventUnseenForNBlocks
  | TxEventSignalDegraded
  | TxEventSignalRecovered
  | TxEventStopped

/**
 * `TxStatus` — cached snapshot the state machine maintains per
 * tracked hash. `getTxStatus(hash)` returns this; the iterator and
 * callback adapters read from the same backing store so all three
 * consumption shapes see consistent state.
 *
 * Carries the **last observation** rather than a derived editorial
 * verb. Consumers interpret the fields as policy.
 */
export interface TxStatus {
  hash: Hash
  chainId: number
  /** Last observed inclusion (null if never observed in a block). */
  lastSeenInBlock: {
    blockHash: Hash
    blockNumber: bigint
    transactionIndex: number
    /** Most recent confirmations count emitted. */
    confirmations: number
    source: EventSource
  } | null
  /** Last observed mempool placement (null if never observed). */
  lastSeenInMempool: {
    bucket: 'pending' | 'queued'
    tx: RawTx
    at: At
    source: EventSource
  } | null
  /** Replacement hash if ever observed (null otherwise). */
  replacedBy: {
    hash: Hash
    blockNumber: bigint | null
  } | null
  /** Last vanished-from-block observation, when applicable. */
  vanishedAt: {
    previousBlockHash: Hash
    canonicalBlockHash: Hash
    blockNumber: bigint
  } | null
  /** Number of consecutive observed blocks the hash has been unseen. */
  unseenStreak: number
  /** First observation block number — used by retention. */
  firstObservedAtBlock: bigint | null
  /** Most recent observation block number — used by retention. */
  lastObservedAtBlock: bigint | null
  /**
   * Block at which this hash reached a terminal-and-finalized state
   * (`replaced-by` emitted, or `unseen-for-N-blocks` emitted). Null
   * while the hash is still in flight. Retention countdown starts
   * here per spec §10 — the tracker drops records and emits
   * `Stopped({ reason: 'retention-expired' })` once
   * `currentBlock > terminalAtBlockNumber + retentionBlocks`. Null
   * means the record is still in flight and is not subject to
   * retention-driven cleanup.
   */
  terminalAtBlockNumber: bigint | null
  /** Capabilities at the most recent emit. */
  capabilities: Capabilities
}

/**
 * Build an event envelope from the per-tracker context plus the
 * call-site overrides. Used by every builder below so the envelope
 * shape is centralized.
 */
const makeEnvelope = (input: Envelope): Envelope => ({
  hash: input.hash,
  chainId: input.chainId,
  source: input.source,
  at: { blockNumber: input.at.blockNumber, timestamp: input.at.timestamp },
})

/** Build a `started` event. */
export const buildStarted = (
  input: Envelope & { capabilities: Capabilities },
): TxEventStarted => ({
  ...makeEnvelope(input),
  kind: 'started',
  capabilities: input.capabilities,
})

/** Build a `seen-in-mempool` event. */
export const buildSeenInMempool = (
  input: Envelope & { bucket: 'pending' | 'queued'; tx: RawTx },
): TxEventSeenInMempool => ({
  ...makeEnvelope(input),
  kind: 'seen-in-mempool',
  bucket: input.bucket,
  tx: input.tx,
})

/** Build a `left-mempool` event. */
export const buildLeftMempool = (input: Envelope): TxEventLeftMempool => ({
  ...makeEnvelope(input),
  kind: 'left-mempool',
})

/** Build a `seen-in-block` event. */
export const buildSeenInBlock = (
  input: Envelope & {
    blockHash: Hash
    blockNumber: bigint
    transactionIndex: number
    confirmations: number
    receipt?: TransactionReceipt
  },
): TxEventSeenInBlock => ({
  ...makeEnvelope(input),
  kind: 'seen-in-block',
  blockHash: input.blockHash,
  blockNumber: input.blockNumber,
  transactionIndex: input.transactionIndex,
  confirmations: input.confirmations,
  ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
})

/**
 * Build a `vanished-from-block` event. Spec §12.3 forbids
 * `source: 'receipt-poll'` for this kind — receipt-poll cannot
 * detect a reorg authoritatively, so the builder rejects that
 * combination at construction rather than letting a malformed
 * event ship to consumers.
 */
export const buildVanishedFromBlock = (
  input: Envelope & {
    previousBlockHash: Hash
    canonicalBlockHash: Hash
    blockNumber: bigint
  },
): TxEventVanishedFromBlock => {
  if (input.source === 'receipt-poll') {
    throw new Error(
      'buildVanishedFromBlock: receipt-poll cannot detect reorgs ' +
        '(spec §12.3). Use block-poll or subscription source.',
    )
  }
  return {
    ...makeEnvelope(input),
    kind: 'vanished-from-block',
    previousBlockHash: input.previousBlockHash,
    canonicalBlockHash: input.canonicalBlockHash,
    blockNumber: input.blockNumber,
  }
}

/** Build a `replaced-by` event. */
export const buildReplacedBy = (
  input: Envelope & {
    replacementHash: Hash
    replacementBlockNumber: bigint | null
  },
): TxEventReplacedBy => ({
  ...makeEnvelope(input),
  kind: 'replaced-by',
  replacementHash: input.replacementHash,
  replacementBlockNumber: input.replacementBlockNumber,
})

/** Build an `unseen-for-N-blocks` event. */
export const buildUnseenForNBlocks = (
  input: Envelope & { blocks: number },
): TxEventUnseenForNBlocks => ({
  ...makeEnvelope(input),
  kind: 'unseen-for-N-blocks',
  blocks: input.blocks,
})

/** Build a `signal-degraded` event. */
export const buildSignalDegraded = (
  input: Envelope & {
    capabilityLost: keyof Capabilities
    fallbackSource: EventSource
  },
): TxEventSignalDegraded => ({
  ...makeEnvelope(input),
  kind: 'signal-degraded',
  capabilityLost: input.capabilityLost,
  fallbackSource: input.fallbackSource,
})

/** Build a `signal-recovered` event. */
export const buildSignalRecovered = (
  input: Envelope & { capabilityRestored: keyof Capabilities },
): TxEventSignalRecovered => ({
  ...makeEnvelope(input),
  kind: 'signal-recovered',
  capabilityRestored: input.capabilityRestored,
})

/** Build a `stopped` event. */
export const buildStopped = (
  input: Envelope & {
    reason: 'unsubscribed' | 'retention-expired' | 'tracker-stopped'
  },
): TxEventStopped => ({
  ...makeEnvelope(input),
  kind: 'stopped',
  reason: input.reason,
})

/**
 * Snapshot constructor for a freshly-tracked hash. Used by the
 * tracker to seed its in-memory record before any observation has
 * landed. All "last observed" fields start `null`; `unseenStreak`
 * starts `0`. Capabilities are passed in (sourced from
 * `source.capabilities()` at construction).
 */
export const buildInitialStatus = (input: {
  hash: Hash
  chainId: number
  capabilities: Capabilities
}): TxStatus => ({
  hash: input.hash,
  chainId: input.chainId,
  lastSeenInBlock: null,
  lastSeenInMempool: null,
  replacedBy: null,
  vanishedAt: null,
  unseenStreak: 0,
  firstObservedAtBlock: null,
  lastObservedAtBlock: null,
  terminalAtBlockNumber: null,
  capabilities: input.capabilities,
})
