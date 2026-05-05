/**
 * @fileoverview The chain-side complement of `sendTransactionWithHooks`.
 *
 * After the wallet returns a hash, an SDK has to:
 *   1. Await the receipt.
 *   2. Distinguish `success` from `reverted`.
 *   3. Fire `onMined` (success) or `onFailed` with a typed revert error
 *      (reverted), so any UI wired against `WriteHookParams` flips to a
 *      terminal state.
 *
 * Without a helper for this, every SDK re-implements the receipt-await +
 * status-check + typed-error-throw block — that's the same drift trap
 * `sendTransactionWithHooks` was added to fix on the wallet side.
 *
 * Drop detection (tx vanished from mempool without inclusion) is
 * intentionally NOT in this helper. Honestly distinguishing "still
 * propagating" from "permanently dropped" requires observing the tx
 * across many blocks with a configurable timeout policy — that's
 * `@valve-tech/tx-tracker`'s job. This helper does ONE receipt-await;
 * if the underlying `waitForTransactionReceipt` itself fires (via
 * its own timeout / abort), the resulting error fires `onFailed` and
 * is re-thrown.
 */

import type { Hex, TransactionReceipt } from 'viem'
import type { WriteHookParams } from './hooks.js'

/**
 * Thrown by `awaitReceiptWithHooks` when the receipt arrives with
 * `status === 'reverted'`. The full receipt is preserved so consumers
 * can extract revert reasons from logs, gas usage, etc.
 *
 * Distinct from a thrown error during the receipt-await itself
 * (network / RPC issues, timeouts) — those are re-thrown unchanged so
 * the SDK can map them to its own error vocabulary.
 */
export class ContractRevertedError extends Error {
  /** The hash of the reverted transaction. */
  readonly hash: Hex
  /** The full receipt with `status === 'reverted'`. */
  readonly receipt: TransactionReceipt

  constructor(hash: Hex, receipt: TransactionReceipt) {
    super('Transaction reverted on-chain.')
    this.name = 'ContractRevertedError'
    this.hash = hash
    this.receipt = receipt
  }
}

/**
 * Minimal viem `PublicClient` slice the helper needs. Defining it
 * locally lets consumers pass a viem client OR a hand-rolled mock
 * without depending on the full `PublicClient` surface.
 */
export interface ReceiptAwaiter {
  waitForTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceipt>
}

export interface AwaitReceiptWithHooksOptions {
  /** A viem `PublicClient` (or anything with the same `waitForTransactionReceipt` shape). */
  publicClient: ReceiptAwaiter
  /** The hash returned by `sendTransactionWithHooks` (or any other broadcast path). */
  hash: Hex
  /** Per-call hooks. `onMined` and `onFailed` fire from this helper. */
  hooks?: WriteHookParams
}

/**
 * Await a transaction receipt and fire the post-hash lifecycle hooks.
 * Throws `ContractRevertedError` on revert. Other errors during the
 * receipt-await are re-thrown unchanged after `onFailed` fires.
 *
 * @example
 * ```ts
 * const hash = await sendTransactionWithHooks({ wallet, request, hooks })
 * const receipt = await awaitReceiptWithHooks({ publicClient, hash, hooks })
 * // Both onMined / onFailed have fired by the time we get here.
 * ```
 */
export async function awaitReceiptWithHooks(
  options: AwaitReceiptWithHooksOptions,
): Promise<TransactionReceipt> {
  const { publicClient, hash, hooks } = options

  let receipt: TransactionReceipt
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash })
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err))
    hooks?.onFailed?.(failure)
    throw failure
  }

  if (receipt.status === 'reverted') {
    const revert = new ContractRevertedError(hash, receipt)
    hooks?.onFailed?.(revert)
    throw revert
  }

  hooks?.onMined?.(receipt)
  return receipt
}
