/**
 * @fileoverview Centralised error handler for wagmi / viem write paths.
 *
 * Encapsulates the rejection-detection + friendly-message + status-reset
 * pattern so every catch block / `onError` callback is a single line. The
 * downstream payoff: a dapp's wallet UX stays consistent across every
 * write site instead of each one re-implementing rejection-vs-failure
 * detection (and getting it slightly wrong).
 */

import { USER_REJECTION_MESSAGE, isUserRejectionError } from './rejection.js'
import { type ErrorPattern, getUserFriendlyErrorMessage } from './messages.js'

/**
 * Sinks the helper writes into when classifying an error.
 */
export interface HandleWalletErrorOptions {
  /** Callback to set a UI status — `idle` on rejection, `error` on real failure. */
  setStatus?: (status: 'idle' | 'error') => void
  /** Callback to store the user-facing message — `null` on rejection, friendly text on failure. */
  setErrorMessage?: (message: string | null) => void
  /** Toast bridge (e.g. sonner). Rejection → `info`, real error → `error`. */
  toast?: { error: (message: string) => void; info: (message: string) => void }
  /** Always called with the underlying error (coerced to `Error`). */
  onError?: (error: Error) => void
  /** Forwarded to `getUserFriendlyErrorMessage`. */
  customErrors?: Record<string, string>
  /** Forwarded to `getUserFriendlyErrorMessage`. */
  patterns?: readonly ErrorPattern[]
  /** Forwarded to `getUserFriendlyErrorMessage`. */
  fallback?: string
}

/**
 * Classify a thrown value as either a user rejection or a real failure, then
 * route the configured sinks accordingly.
 *
 * @example
 * ```ts
 * // wagmi onError shape
 * onError: (err) => handleWalletError(err, {
 *   setStatus: setTxStatus,
 *   setErrorMessage: setError,
 *   toast,
 *   customErrors: { HashMismatch: 'Proof did not match.' },
 * })
 *
 * // catch block shape
 * try {
 *   await writeAsync(args)
 * } catch (err) {
 *   handleWalletError(err, { setStatus, setErrorMessage, toast })
 * }
 * ```
 */
export function handleWalletError(
  error: unknown,
  options: HandleWalletErrorOptions = {},
): void {
  const { setStatus, setErrorMessage, toast, onError, customErrors, patterns, fallback } = options

  if (isUserRejectionError(error)) {
    setStatus?.('idle')
    setErrorMessage?.(null)
    toast?.info(USER_REJECTION_MESSAGE)
  } else {
    const message = getUserFriendlyErrorMessage(error, { customErrors, patterns, fallback })
    setStatus?.('error')
    setErrorMessage?.(message)
    toast?.error(message)
  }

  onError?.(error instanceof Error ? error : new Error(String(error)))
}
