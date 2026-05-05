/**
 * @fileoverview Per-call lifecycle hooks for any SDK method that opens a
 * wallet popup, awaits inclusion, and may later observe replacement or
 * mempool drop.
 *
 * The contract describes EVERY phase a tracked tx can be in. Different
 * fire-ers cover different slices:
 *
 *   - `sendTransactionWithHooks` fires the wallet-side phases
 *     (`awaiting-signature`, `pending`, plus `failed` on rejection /
 *     wallet-side network error).
 *   - `awaitReceiptWithHooks` fires the chain-side terminal phases
 *     (`confirmed` or `failed` on revert / receipt-await error).
 *   - `@valve-tech/tx-tracker` (per-tx state machine, observes across
 *     blocks) fires `dropped` and `replaced` once it ships, plus may
 *     re-emit transitions if a tx surfaces / vanishes / surfaces again
 *     across reorgs.
 *   - The SDK itself may fire `preparing` at the very start of its
 *     write method, before any pre-wallet work begins.
 *
 * Two shapes are available — complementary, not alternatives:
 *
 *   - **Named hooks** (`onAwaitingSignature`, `onConfirmed`, etc.) —
 *     ergonomic, easy to wire from a hook-like API, narrow types per
 *     callback.
 *   - **`onPhase(event)`** — single-callback discriminated union.
 *     Better for state-machine consumers that need a single transition
 *     point and exhaustive `switch`-coverage on the phase name.
 *
 * Fire-ers fire BOTH shapes for every transition — exactly once each —
 * so consumers can choose which to wire without affecting the other.
 *
 * Every payload carries a `TxContext` (`chainId` + `request`) so
 * consumers never have to side-channel the originating chain or the
 * original send request to use the events. `confirmed` and
 * receipt-bearing `failed` events also carry the containing `Block` so
 * downstream trackers don't have to re-fetch it for timestamp / fee
 * analytics — that's the "don't make consumers re-gather what we
 * already have" rule the events are designed around.
 */

import type { Block, Hex, TransactionReceipt } from 'viem'
import type { WalletSendTransactionRequest } from './wallet.js'

/**
 * Every lifecycle phase a tracked transaction can be in, from intent
 * through terminal observation. Carriers (helpers, trackers, SDKs)
 * fire transitions in roughly this order, though `dropped` and
 * `replaced` may arrive late or interleave with re-emissions on reorg.
 */
export type WritePhase =
  | 'preparing'
  | 'awaiting-signature'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'dropped'
  | 'replaced'

/**
 * Per-phase data delta. Each entry is exactly the fields available at
 * that phase BEYOND the always-present `TxContext` (`chainId`,
 * `request`).
 *
 * Adding a new phase is one entry here plus a fire-er; adding a new
 * shared field is one entry in `TxContext`. The `WritePhaseEvent`
 * union is derived from this map, so variants stay in lockstep
 * mechanically.
 *
 * Declared as an `interface` (not a `type`) so consumers can use
 * declaration merging to extend the map with their own phases — useful
 * for trackers that surface implementation-specific transitions
 * without forking the union.
 *
 * `block` is optional on `confirmed` / `failed` / `replaced` because
 * `awaitReceiptWithHooks` allows opting out of the block fetch via
 * `includeBlock: false`. Trackers that observe `replaced` from the
 * mempool may also fire it without a receipt.
 */
export interface WritePhaseSteps {
  preparing: object
  'awaiting-signature': object
  pending: { hash: Hex }
  confirmed: { hash: Hex; receipt: TransactionReceipt; block?: Block }
  failed: { error: Error; hash?: Hex; receipt?: TransactionReceipt; block?: Block }
  dropped: { hash: Hex }
  replaced: { original: Hex; replacement: Hex; receipt?: TransactionReceipt; block?: Block }
}

/**
 * Always-present transaction context surrounding every phase event.
 * Carries the chain identity and the original send request so
 * consumers don't have to maintain a side-channel `hash → request` map
 * or call `client.chain.id` from inside their callbacks.
 *
 * `Extra` is the per-phase delta from `WritePhaseSteps[K]`. Defaulting
 * `Extra` to `object` lets the bare `TxContext` describe phases with
 * no extra fields (`preparing`, `awaiting-signature`).
 */
export type TxContext<Extra extends object = object> = {
  /** Chain id this transaction targets. Pulled off `request.chainId`. */
  chainId: number
  /**
   * The fully-formed wallet send request as passed into the SDK
   * (`to`, `data`, `value`, `chainId`, gas inputs). Carried verbatim
   * so consumers can construct a tracked-tx record or replay the
   * input without extra plumbing.
   */
  request: WalletSendTransactionRequest
} & Extra

/**
 * Discriminated-union event payload for the `onPhase` callback.
 * Switch on `event.phase` and TypeScript narrows the rest of the
 * fields automatically — no `event.context?.receipt` indirection.
 *
 * Derived mechanically from `WritePhaseSteps` × `TxContext` so adding
 * a phase to the map is the only edit needed to extend the union.
 */
export type WritePhaseEvent = {
  [K in keyof WritePhaseSteps]: { phase: K } & TxContext<WritePhaseSteps[K]>
}[keyof WritePhaseSteps]

/**
 * Per-call hooks fired at real boundaries during a tracked tx's
 * lifecycle. Every field is optional. SDKs and trackers fire whichever
 * subset corresponds to phases they actually observe; consumers wire
 * only the ones their UI needs.
 *
 * Each named hook receives a `TxContext<WritePhaseSteps[K]>` info bag
 * matching the phase. The `onPhase` complement receives the full
 * discriminated union. Fire-ers fire both for every transition — the
 * named hook (if a consumer wired it) and `onPhase` (if a consumer
 * wired it) — so no transition is observable from one shape but not
 * the other.
 */
export interface WriteHookParams {
  /**
   * Called once, immediately before `wallet.sendTransaction`. UI flips
   * from "preparing" to "awaiting wallet signature" at the precise
   * boundary, regardless of how much pre-wallet work the SDK did.
   */
  onAwaitingSignature?: (info: TxContext<WritePhaseSteps['awaiting-signature']>) => void
  /**
   * Called once with the on-chain tx hash plus full context,
   * immediately after `sendTransaction` resolves and *before* any
   * receipt-await. UI flips from "awaiting" to "pending" the moment
   * the hash exists.
   *
   * Per-call vs constructor-level: SDKs may also expose a separate
   * constructor-level `onTransactionHash` channel for analytics /
   * global observers — they're complementary, fire on the same line
   * with the same payload.
   */
  onTransactionHash?: (info: TxContext<WritePhaseSteps['pending']>) => void
  /**
   * Called once when `receipt.status === 'success'`. Receives the full
   * info bag — `hash`, `receipt`, optional `block` (present unless
   * `includeBlock: false` was passed), plus `chainId` and `request` —
   * so consumers don't re-fetch the block for timestamp / baseFee
   * UI.
   */
  onConfirmed?: (info: TxContext<WritePhaseSteps['confirmed']>) => void
  /**
   * Called once with the underlying error (and any context available
   * at the failure point) on any terminal failure that is NOT a
   * replacement or a drop:
   *   - wallet rejection (`WalletRejectedError`)
   *   - on-chain revert (`ContractRevertedError`)
   *   - any other thrown error from the wallet or RPC.
   *
   * Use `instanceof` against `WalletRejectedError` /
   * `ContractRevertedError` to discriminate; everything else is a
   * plain `Error`. Wallet-side failures carry no `hash` / `receipt`;
   * receipt-bearing failures (revert) carry both, plus the block
   * (unless `includeBlock: false`).
   */
  onFailed?: (info: TxContext<WritePhaseSteps['failed']>) => void
  /**
   * Called once when a tracker has determined the tx will not be
   * included — typically: not seen in mempool for N consecutive blocks
   * AND no receipt arrived AND no replacement nonce mined. The exact
   * timeout policy is the tracker's call (configurable per consumer).
   *
   * Helpers in THIS package never fire `onDropped` — distinguishing
   * "still propagating" from "permanently dropped" requires multi-block
   * observation. Wire this against a `tx-tracker` instance, not against
   * `awaitReceiptWithHooks`.
   */
  onDropped?: (info: TxContext<WritePhaseSteps['dropped']>) => void
  /**
   * Called once when a tracker observes that a *different* tx with the
   * same nonce mined in place of the one we were watching — typically
   * the user's own speed-up / cancel from their wallet, or a
   * fee-replacement broadcast separately.
   *
   * `info.receipt` and `info.block` are populated when the replacement
   * has been mined; trackers may emit `replaced` without them if they
   * only saw the replacement in the mempool.
   */
  onReplaced?: (info: TxContext<WritePhaseSteps['replaced']>) => void
  /**
   * Single-callback complement to the named hooks. Fires for every
   * lifecycle transition with a discriminated-union payload. Useful
   * for state-machine consumers that prefer one transition point and
   * exhaustive `switch`-coverage over wiring six separate callbacks.
   *
   * Fire-ers fire BOTH `onPhase` and the matching named hook on each
   * transition — exactly once each — so wiring one shape doesn't
   * preclude the other.
   */
  onPhase?: (event: WritePhaseEvent) => void
}
