/**
 * @fileoverview Lifecycle vocabulary for tracked transactions.
 *
 * Defines the shared status / flow constants and the `TrackedTx` shape
 * so any SDK or UI can speak the same vocabulary about a transaction
 * in flight. This is the **opinion** layer that an in-flight UI sits on
 * top of `@valve-tech/tx-tracker`'s neutral observations.
 *
 * Why constants instead of plain string types: consumers MUST reference
 * via `TX_STATUS.preparing` / `TX_FLOW.signalIntent` rather than
 * writing raw strings, so a rename here propagates through the type
 * system instead of leaving stale literals at call sites.
 */

import type { Hex } from 'viem'

// ─── Status ────────────────────────────────────────────────────────────────

/**
 * Canonical lifecycle states for a tracked transaction.
 *
 * Lifecycle:
 *   preparing → awaiting-signature → pending → mined | failed | dropped
 *                                            ↘ replaced (on speed-up)
 *
 * The two pre-hash states (`preparing`, `awaitingSignature`) carry no
 * `hash` and cannot be receipt-polled. They exist so the UI has
 * something to show during gas-estimation + wallet-sign — without them
 * the strip would stay blank until after the wallet returns.
 */
export const TX_STATUS = {
  preparing:         'preparing',
  awaitingSignature: 'awaiting-signature',
  pending:           'pending',
  mined:             'mined',
  failed:            'failed',
  replaced:          'replaced',
  dropped:           'dropped',
} as const

export type TrackedTxStatus = typeof TX_STATUS[keyof typeof TX_STATUS]

// ─── Flow ──────────────────────────────────────────────────────────────────

/**
 * The "what is the user doing" label for a tracked transaction. Distinct
 * from `status` (which is the lifecycle phase): `flow` describes the
 * action and stays constant for the whole lifecycle, while `status`
 * advances over time.
 *
 * This is a generic / extensible enum — protocols add their own flow
 * names by extending the type. The base set ships none of its own,
 * intentionally: every protocol's flow vocabulary is its own.
 */
export const TX_FLOW = {} as const

export type TxFlow = string

// ─── TrackedTx ─────────────────────────────────────────────────────────────

/**
 * Gas the wallet actually sent the transaction with. Captured at submit
 * time so a speed-up replacement can compute the EIP-1559 ≥10% bump
 * relative to what's actually in the mempool, not what the oracle
 * estimated when the user clicked.
 */
export interface TrackedTxGas {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/**
 * One in-flight (or recently-terminal) transaction the UI is showing.
 *
 * `id` is the stable identifier — assigned at the registry's `beginTx`
 * time, before any hash exists. `hash` is attached later (when
 * `wallet.sendTransaction` resolves). For post-hash callers using a
 * legacy `trackTx({ hash, ... })` API, registries SHOULD default `id`
 * to `hash` so existing code keeps working unchanged.
 *
 * `submittedTier` is a string so this type doesn't need to depend on
 * `@valve-tech/gas-oracle`'s `TierName`. Consumers using the oracle
 * can refine it locally.
 */
export interface TrackedTx {
  id: string
  hash?: Hex
  chainId: number
  flow: TxFlow
  submittedAt: number
  confirmedAt?: number
  submittedGas?: TrackedTxGas
  submittedTier: string
  status: TrackedTxStatus
  replacedBy?: Hex
  replaces?: Hex
  /**
   * Human-readable note for terminal-with-detail states. UIs SHOULD
   * prefer `notes` over generic copy when rendering `failed` /
   * `dropped` so a "cancelled in wallet" or decoded error name surfaces
   * instead of a flat "transaction failed".
   */
  notes?: string
}

// ─── Display windows ───────────────────────────────────────────────────────

/**
 * How long a stale (older than this) tracked tx may be ignored by
 * receipt-polling logic. Default mirrors the chosen UX in tx-flight
 * surfaces: 10 minutes is long enough for a slow inclusion, short
 * enough to garbage-collect zombie entries.
 */
export const STALE_TX_AGE_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Symmetric linger windows for terminal-with-detail states. These let
 * confirmed/failed states stay on screen long enough for the user to
 * read the outcome without permanently occupying the UI surface.
 */
export const CONFIRMED_DISPLAY_MS = 10_000
export const FAILED_DISPLAY_MS = 10_000

// ─── Callback types ────────────────────────────────────────────────────────

/** Fired once when a tracked tx becomes `mined`. */
export type TxConfirmedCallback = (tx: TrackedTx) => void | Promise<void>
