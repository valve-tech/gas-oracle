/**
 * `TxGroupEvent` — composite event union for `tracker.group([...hashes])`
 * cross-tx correlation (spec §18.1, v0.8.0 design F3).
 *
 * Group emits its own kinds (group-progress / group-complete /
 * group-failed / group-stopped) derived from the per-member event
 * streams. Per-member events still flow through the underlying
 * tracker.subscribe path; the group is a synthesis layer on top.
 *
 * Pure data shapes + pure builders. No I/O, no mutation.
 */

import type { At, Hash } from './events.js'

/**
 * Common envelope on every group event. Carries the group identifier
 * and the block coordinate the observation was made at.
 */
export interface TxGroupEventEnvelope {
  groupId: string
  at: At
}

/**
 * Emitted when one or more members of the tracked group have reached
 * inclusion in the canonical chain. `confirmed` is the count of members
 * observed in blocks; `total` is the group size; `lastHash` is the most
 * recently-included member's hash.
 */
export interface TxGroupEventProgress extends TxGroupEventEnvelope {
  kind: 'group-progress'
  confirmed: number
  total: number
  lastHash: Hash
}

/**
 * All members of the group have reached inclusion in the canonical
 * chain and none have been replaced or reorged. Final progress event
 * before group stream closes (unless a reorg or replacement occurs).
 */
export interface TxGroupEventComplete extends TxGroupEventEnvelope {
  kind: 'group-complete'
  total: number
}

/**
 * One member of the group was dropped (unseen for the threshold),
 * failed (reverted or invalid), or replaced by a different tx with
 * the same (from, nonce) pair. `reason` disambiguates the failure mode.
 */
export interface TxGroupEventFailed extends TxGroupEventEnvelope {
  kind: 'group-failed'
  failedHash: Hash
  reason: 'dropped' | 'failed' | 'replaced'
}

/**
 * Group subscription was stopped before all members reached inclusion.
 * Fires once per group subscription. Always the final event in the
 * stream for that group.
 */
export interface TxGroupEventStopped extends TxGroupEventEnvelope {
  kind: 'group-stopped'
}

/**
 * Discriminated union of every group event variant. Narrow on `kind`
 * to access variant-specific fields.
 */
export type TxGroupEvent =
  | TxGroupEventProgress
  | TxGroupEventComplete
  | TxGroupEventFailed
  | TxGroupEventStopped

/**
 * Build an event envelope from the group context. Used by every builder
 * below so the envelope shape is centralized and always produces a fresh
 * copy (no aliasing).
 */
const makeEnvelope = (input: TxGroupEventEnvelope): TxGroupEventEnvelope => ({
  groupId: input.groupId,
  at: { blockNumber: input.at.blockNumber, timestamp: input.at.timestamp },
})

/** Build a `group-progress` event. */
export const buildGroupProgress = (
  input: TxGroupEventEnvelope & { confirmed: number; total: number; lastHash: Hash },
): TxGroupEventProgress => ({
  ...makeEnvelope(input),
  kind: 'group-progress',
  confirmed: input.confirmed,
  total: input.total,
  lastHash: input.lastHash,
})

/** Build a `group-complete` event. */
export const buildGroupComplete = (
  input: TxGroupEventEnvelope & { total: number },
): TxGroupEventComplete => ({
  ...makeEnvelope(input),
  kind: 'group-complete',
  total: input.total,
})

/** Build a `group-failed` event. */
export const buildGroupFailed = (
  input: TxGroupEventEnvelope & {
    failedHash: Hash
    reason: 'dropped' | 'failed' | 'replaced'
  },
): TxGroupEventFailed => ({
  ...makeEnvelope(input),
  kind: 'group-failed',
  failedHash: input.failedHash,
  reason: input.reason,
})

/** Build a `group-stopped` event. */
export const buildGroupStopped = (
  input: TxGroupEventEnvelope,
): TxGroupEventStopped => ({
  ...makeEnvelope(input),
  kind: 'group-stopped',
})
