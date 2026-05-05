/**
 * @fileoverview Per-call lifecycle hooks for any SDK method that opens a
 * wallet popup and waits for inclusion.
 *
 * Why this is a contract instead of an implementation: the actual hook
 * firing lives inside each SDK's write method (the SDK knows where the
 * pre-wallet work ends), but the **shape** of the contract should be
 * shared so dapps and tx-state UIs can wire one set of callbacks
 * regardless of which SDK is firing them.
 *
 * Lifecycle the contract describes:
 *   (caller's pre-wallet work)
 *     → onAwaitingSignature
 *     → wallet.sendTransaction
 *     → onTransactionHash(hash)
 *     → waitForTransactionReceipt
 *     → SDK resolves
 */

import type { Hex } from 'viem'

/**
 * Per-call hooks fired at real boundaries inside an SDK write method.
 *
 * SDKs that own a write method should accept these as optional fields on
 * the method's params object (e.g.
 * `signalIntent(params: SignalIntentParams & WriteHookParams)`) and fire
 * them at the boundaries described below.
 */
export interface WriteHookParams {
  /**
   * Called once, immediately before `wallet.sendTransaction`. Lets
   * callers flip their tx-state UI from "preparing" to "awaiting wallet
   * signature" at the precise boundary, regardless of how much
   * pre-wallet work the SDK did first (gas estimation, indexer fetches,
   * simulation, etc.).
   *
   * Implementation note for SDK authors: fire this exactly once, on the
   * line *immediately preceding* `wallet.sendTransaction(...)`. Firing
   * earlier ("we're about to start preparing") makes the
   * awaiting-signature state stick before the wallet popup actually
   * opens — which surprises users.
   */
  onAwaitingSignature?: () => void
  /**
   * Called once with the on-chain tx hash, immediately after
   * `sendTransaction` resolves and *before* the SDK begins awaiting the
   * receipt. Lets callers transition their tx-state UI from "awaiting"
   * to "pending" the moment the hash exists, instead of staying in
   * "awaiting" for the full receipt-confirmation window.
   *
   * Per-call vs constructor-level: SDKs may also expose a separate
   * constructor-level `onTransactionHash` for analytics / global
   * observers that don't need per-call correlation. The two channels
   * are complementary — fire both on the same line.
   */
  onTransactionHash?: (hash: Hex) => void
}

/**
 * Forward-looking single-callback shape for SDKs that need more than two
 * lifecycle phases. Documented here so adopters of `WriteHookParams` who
 * later need a third phase (e.g. simulation, broadcasting, indexer-sync)
 * have a migration target instead of growing the boolean-named callback
 * surface.
 *
 * SDKs MAY accept `onPhase` alongside the named hooks; if both are
 * supplied they should fire each named hook exactly when its
 * corresponding phase fires (don't double-fire from a single transition).
 */
export type WritePhase =
  | 'preparing'
  | 'awaiting-signature'
  | 'broadcasted'
  | 'mined'

export interface WritePhaseContext {
  hash?: Hex
  receipt?: unknown
}

export interface WritePhaseHookParams {
  onPhase?: (phase: WritePhase, context?: WritePhaseContext) => void
}
