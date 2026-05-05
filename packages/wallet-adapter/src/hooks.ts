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
 * Lifecycle the contract describes (every named hook is optional):
 *   (caller's pre-wallet work)
 *     → onAwaitingSignature
 *     → wallet.sendTransaction
 *     → onTransactionHash(hash)
 *     → waitForTransactionReceipt
 *     → onMined(receipt) | onFailed(error)
 *     → SDK resolves / rejects
 *
 * "Dropped from mempool without inclusion" is intentionally NOT a hook
 * here. Distinguishing "still propagating" from "permanently dropped"
 * requires observing the tx across many blocks with a configurable
 * timeout policy — that's `@valve-tech/tx-tracker`'s job. This contract
 * covers the one-shot lifecycle of a single send + receipt-await.
 */

import type { Hex, TransactionReceipt } from 'viem'

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
  /**
   * Called once with the mined receipt when `receipt.status === 'success'`.
   * Lets callers flip their tx-state UI to a "confirmed" / terminal
   * success state. Receives the full receipt so consumers can extract
   * block number, gas used, decoded events, etc.
   *
   * Fired by `awaitReceiptWithHooks` (or by SDK code that performs its
   * own receipt-await) immediately before the SDK resolves.
   */
  onMined?: (receipt: TransactionReceipt) => void
  /**
   * Called once with the underlying error on any terminal failure:
   *   - wallet rejection (`WalletRejectedError`) — fired by
   *     `sendTransactionWithHooks`
   *   - on-chain revert (`ContractRevertedError`) — fired by
   *     `awaitReceiptWithHooks` when `receipt.status === 'reverted'`
   *   - any other thrown error from the wallet adapter or RPC — fired by
   *     whichever helper observed the throw, with the original error
   *     re-thrown after the hook fires.
   *
   * Lets callers flip their tx-state UI to a "failed" / terminal error
   * state. Use `instanceof` against `WalletRejectedError` /
   * `ContractRevertedError` to discriminate; everything else is a plain
   * `Error` (network failure, RPC timeout, etc.).
   */
  onFailed?: (error: Error) => void
}
