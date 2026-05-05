/**
 * @fileoverview The single SDK helper for sending a transaction with
 * lifecycle hooks fired at the real boundaries.
 *
 * This is the runtime piece of the lifecycle contract. SDK authors call
 * this from inside any write method that opens a wallet popup; it
 * guarantees:
 *   - `onAwaitingSignature` fires exactly once, immediately before
 *     `wallet.sendTransaction(...)`.
 *   - `onTransactionHash` (per-call) and the global `onTransactionHash`
 *     channel fire exactly once each, after `sendTransaction` resolves
 *     and BEFORE the SDK awaits any receipt — so callers can flip their
 *     UI from `awaiting-signature` to `pending` the moment a hash exists
 *     instead of stalling for the full inclusion window.
 *   - Wallet rejections (EIP-1193 `code === 4001`, viem's
 *     `UserRejectedRequestError`, or matching message text — see
 *     `@valve-tech/viem-errors` for the detection signals) are converted
 *     to a `WalletRejectedError` so consumers can `instanceof`-check
 *     them. Non-rejection errors are re-thrown unchanged so the SDK
 *     can map them to its own typed error vocabulary.
 *
 * Without this helper, every SDK that wants the contract has to
 * re-implement: the error-mapping `try/catch` block (with the
 * three-signal rejection check), the constructor-vs-per-call hook
 * fan-out, and the precise ordering relative to `sendTransaction`.
 */

import type { Hex } from 'viem'
import { isUserRejectionError } from '@valve-tech/viem-errors'
import type { WalletAdapter, WalletSendTransactionRequest } from './wallet.js'
import type { WriteHookParams } from './hooks.js'

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
  /** Per-call lifecycle hooks. Both fields are optional. */
  hooks?: WriteHookParams
  /**
   * Optional global / constructor-level `onTransactionHash` channel.
   * Fires alongside `hooks.onTransactionHash` on the same line —
   * complementary, not alternatives. Use this for analytics or
   * debug-logging that should observe every write regardless of which
   * caller fired it.
   */
  onTransactionHash?: (hash: Hex) => void
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
 *   const receipt = await this.publicClient.waitForTransactionReceipt({ hash })
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

  let hash: Hex
  try {
    hooks?.onAwaitingSignature?.()
    hash = await wallet.sendTransaction(request)
  } catch (err) {
    if (isUserRejectionError(err)) {
      const cause = err instanceof Error ? err : new Error(String(err))
      throw new WalletRejectedError(cause)
    }
    throw err
  }

  onTransactionHash?.(hash)
  hooks?.onTransactionHash?.(hash)
  return hash
}
