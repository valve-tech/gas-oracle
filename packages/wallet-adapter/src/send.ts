/**
 * @fileoverview The single SDK helper for sending a transaction with
 * lifecycle hooks fired at the real boundaries.
 *
 * This is the runtime piece of the lifecycle contract. SDK authors call
 * this from inside any write method that opens a wallet popup; it
 * guarantees:
 *   - `onAwaitingSignature` fires exactly once with `TxContext` (chainId
 *     + request), immediately before `wallet.sendTransaction(...)`.
 *   - `onTransactionHash` (per-call) and the global `onTransactionHash`
 *     channel fire exactly once each with `TxContext + hash`, after
 *     `sendTransaction` resolves and BEFORE the SDK awaits any receipt
 *     — so callers can flip their UI from `awaiting-signature` to
 *     `pending` the moment a hash exists instead of stalling for the
 *     full inclusion window.
 *   - Wallet rejections (EIP-1193 `code === 4001`, viem's
 *     `UserRejectedRequestError`, or matching message text — see
 *     `@valve-tech/viem-errors` for the detection signals) are converted
 *     to a `WalletRejectedError` so consumers can `instanceof`-check
 *     them. Non-rejection errors are re-thrown unchanged so the SDK
 *     can map them to its own typed error vocabulary.
 *
 * Every payload carries `chainId` and the original `request`, so
 * analytics observers and tx-tracker consumers don't need to keep a
 * side-channel `hash → request` map or read chainId off the client.
 */

import type { Hex } from 'viem'
import { isUserRejectionError } from '@valve-tech/viem-errors'
import type { WalletAdapter, WalletSendTransactionRequest } from './wallet.js'
import type { TxContext, WriteHookParams, WritePhaseSteps } from './hooks.js'

/**
 * Thrown by `sendTransactionWithHooks` when the wallet rejection is
 * detected at any level of the cause chain. The original error is
 * preserved as `cause` so consumers can still inspect it (locale
 * details, exact wallet phrasing, etc.) when they map this to their
 * own typed error vocabulary.
 */
export class WalletRejectedError extends Error {
  /** The original rejection thrown by the wallet adapter. */
  readonly cause: Error

  constructor(cause: Error) {
    super('Transaction was rejected in wallet.')
    this.name = 'WalletRejectedError'
    this.cause = cause
  }
}

/**
 * Options accepted by `sendTransactionWithHooks`.
 */
export interface SendTransactionWithHooksOptions {
  /** The wallet adapter that will sign + broadcast the request. */
  wallet: WalletAdapter
  /** The fully-formed send request (calldata, gas inputs, chainId). */
  request: WalletSendTransactionRequest
  /** Per-call lifecycle hooks. All fields are optional. */
  hooks?: WriteHookParams
  /**
   * Optional global / constructor-level `onTransactionHash` channel.
   * Fires alongside `hooks.onTransactionHash` on the same line —
   * complementary, not alternatives. Receives the same rich
   * `TxContext + hash` payload so analytics observers don't have to
   * resolve chainId / request from a side channel.
   */
  onTransactionHash?: (info: TxContext<WritePhaseSteps['pending']>) => void
}

/**
 * Submit a transaction through the wallet adapter, firing lifecycle
 * hooks at the real boundaries and converting wallet rejections to a
 * typed `WalletRejectedError`.
 *
 * @example
 * ```ts
 * try {
 *   const hash = await sendTransactionWithHooks({
 *     wallet: this.wallet,
 *     request: { ...prepared, ...gasInputs },
 *     hooks: params,                     // user-supplied per-call hooks
 *     onTransactionHash: this.onHash,    // constructor-level / analytics
 *   })
 *   const receipt = await awaitReceiptWithHooks({
 *     publicClient,
 *     hash,
 *     request: { ...prepared, ...gasInputs },
 *     hooks: params,
 *   })
 *   return { hash, receipt }
 * } catch (err) {
 *   if (err instanceof WalletRejectedError) {
 *     throw new MySdkError('WALLET_REJECTED', err.message, err.cause)
 *   }
 *   throw new MySdkError('CONTRACT_ERROR', (err as Error).message, err as Error)
 * }
 * ```
 */
export async function sendTransactionWithHooks(
  options: SendTransactionWithHooksOptions,
): Promise<Hex> {
  const { wallet, request, hooks, onTransactionHash } = options
  const ctx: TxContext = { chainId: request.chainId, request }

  let hash: Hex
  try {
    hooks?.onAwaitingSignature?.(ctx)
    hooks?.onPhase?.({ phase: 'awaiting-signature', ...ctx })
    hash = await wallet.sendTransaction(request)
  } catch (err) {
    const failure = isUserRejectionError(err)
      ? new WalletRejectedError(err instanceof Error ? err : new Error(String(err)))
      : err instanceof Error
        ? err
        : new Error(String(err))
    const failedInfo: TxContext<WritePhaseSteps['failed']> = { ...ctx, error: failure }
    hooks?.onFailed?.(failedInfo)
    hooks?.onPhase?.({ phase: 'failed', ...failedInfo })
    throw failure
  }

  const pendingInfo: TxContext<WritePhaseSteps['pending']> = { ...ctx, hash }
  onTransactionHash?.(pendingInfo)
  hooks?.onTransactionHash?.(pendingInfo)
  hooks?.onPhase?.({ phase: 'pending', ...pendingInfo })
  return hash
}
