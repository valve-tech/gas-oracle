/**
 * @fileoverview The chain-side complement of `sendTransactionWithHooks`.
 *
 * After the wallet returns a hash, an SDK has to:
 *   1. Await the receipt.
 *   2. Pull the containing block (so consumers don't re-fetch it just
 *      for `timestamp` / `baseFeePerGas`).
 *   3. Distinguish `success` from `reverted`.
 *   4. Fire `onConfirmed` (success) or `onFailed` with a typed revert
 *      error (reverted), plus `onPhase` for the same transition, so any
 *      UI wired against `WriteHookParams` flips to a terminal state.
 *
 * Without a helper for this, every SDK re-implements: the receipt-await
 * + block-fetch + status-check + typed-error-throw block — and worse,
 * every SDK either re-fetches the block in its own callbacks or skips
 * it and forces every consumer to fetch it. The amortization here is
 * the whole point: one `getBlock` call inside this helper, every
 * downstream consumer skips it.
 *
 * Drop detection (tx vanished from mempool without inclusion) and
 * replacement detection are deliberately NOT in this helper. They
 * require observing the tx across many blocks with a configurable
 * timeout policy and nonce-watching — that's
 * `@valve-tech/tx-tracker`'s job. The `WriteHookParams` contract
 * defines `onDropped` / `onReplaced` so consumers can wire them once;
 * this helper just doesn't fire them.
 */

import type { Block, Hex, TransactionReceipt } from 'viem'
import type { TxContext, WriteHookParams, WritePhaseSteps } from './hooks.js'
import type { WalletSendTransactionRequest } from './wallet.js'

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
 *
 * `getBlock` is invoked once on receipt success / revert (when
 * `includeBlock` is left at its default of `true`) so the resulting
 * `confirmed` / `failed` event payload carries the block timestamp,
 * baseFeePerGas, etc. without forcing every consumer to fetch it.
 */
export interface ReceiptAwaiter {
  waitForTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceipt>
  getBlock(args: { blockHash: Hex }): Promise<Block>
}

export interface AwaitReceiptWithHooksOptions {
  /** A viem `PublicClient` (or anything with the same shape). */
  publicClient: ReceiptAwaiter
  /** The hash returned by `sendTransactionWithHooks` (or any other broadcast path). */
  hash: Hex
  /**
   * The original send request. Carried into all phase events as part
   * of the always-present `TxContext` so consumers don't have to
   * maintain a side-channel `hash → request` map.
   */
  request: WalletSendTransactionRequest
  /**
   * Whether to fetch and attach the containing `Block` to `confirmed`
   * and revert-`failed` event payloads. Defaults to `true` — the
   * helper is the right place to amortize the block fetch on behalf of
   * every downstream consumer. Pass `false` to skip the extra RPC
   * round trip when no consumer needs block-level data.
   */
  includeBlock?: boolean
  /** Per-call hooks. `onConfirmed` and `onFailed` fire from this helper. */
  hooks?: WriteHookParams
}

/**
 * Await a transaction receipt and fire the post-hash lifecycle hooks
 * with rich payloads (chainId, request, hash, receipt, block).
 *
 * Throws `ContractRevertedError` on revert. Other errors during the
 * receipt-await are re-thrown unchanged after `onFailed` fires.
 *
 * @example
 * ```ts
 * const hash = await sendTransactionWithHooks({ wallet, request, hooks })
 * const receipt = await awaitReceiptWithHooks({
 *   publicClient,
 *   hash,
 *   request,        // same shape passed to sendTransactionWithHooks
 *   hooks,
 * })
 * // onConfirmed / onFailed have fired by the time we get here, with
 * // chainId + request + hash + receipt + block in scope.
 * ```
 */
export async function awaitReceiptWithHooks(
  options: AwaitReceiptWithHooksOptions,
): Promise<TransactionReceipt> {
  const { publicClient, hash, request, includeBlock = true, hooks } = options
  const ctx: TxContext = { chainId: request.chainId, request }

  let receipt: TransactionReceipt
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash })
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err))
    const failedInfo: TxContext<WritePhaseSteps['failed']> = { ...ctx, error: failure }
    hooks?.onFailed?.(failedInfo)
    hooks?.onPhase?.({ phase: 'failed', ...failedInfo })
    throw failure
  }

  const block = includeBlock
    ? await publicClient.getBlock({ blockHash: receipt.blockHash })
    : undefined

  if (receipt.status === 'reverted') {
    const revert = new ContractRevertedError(hash, receipt)
    const failedInfo: TxContext<WritePhaseSteps['failed']> = {
      ...ctx,
      error: revert,
      hash,
      receipt,
      ...(block ? { block } : {}),
    }
    hooks?.onFailed?.(failedInfo)
    hooks?.onPhase?.({ phase: 'failed', ...failedInfo })
    throw revert
  }

  const confirmedInfo: TxContext<WritePhaseSteps['confirmed']> = {
    ...ctx,
    hash,
    receipt,
    ...(block ? { block } : {}),
  }
  hooks?.onConfirmed?.(confirmedInfo)
  hooks?.onPhase?.({ phase: 'confirmed', ...confirmedInfo })
  return receipt
}
