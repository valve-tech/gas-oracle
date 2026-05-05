/**
 * @fileoverview Map raw viem / wagmi / wallet errors to short user-friendly
 * messages.
 *
 * The default `DEFAULT_ERROR_PATTERNS` is deliberately protocol-agnostic —
 * wallet rejection, gas/funds, replacement-tx, network/RPC, rate-limit,
 * generic revert. Consumers add their protocol-specific custom-Solidity-error
 * messages via the `customErrors` option on `getUserFriendlyErrorMessage`,
 * and can prepend additional patterns via the `patterns` option without
 * editing the default list.
 *
 * Match order at runtime:
 *   1. Wallet rejection — surfaced first so a 4001 buried inside a wrapper
 *      whose top-level message contains "execution reverted" still produces
 *      the cancelled-by-user copy instead of the generic on-chain fallback.
 *   2. Decoded custom-error name from `data.errorName` anywhere in the
 *      cause chain — best signal when the ABI is wired through viem.
 *   3. Custom-error name extracted from the wrapper's stringified message —
 *      a flattened-cause-chain fallback.
 *   4. Caller-supplied additional patterns (checked BEFORE defaults so a
 *      consumer can override generic copy).
 *   5. Default protocol-agnostic patterns.
 *   6. The configured `fallback`, or a generic message.
 */

import { extractContractErrorName, extractContractErrorNameFromMessage } from './contract-error.js'
import { isUserRejectionError } from './rejection.js'

/** A pattern → message pair used by `getUserFriendlyErrorMessage`. */
export interface ErrorPattern {
  pattern: RegExp
  message: string
}

/**
 * Default protocol-agnostic patterns. Consumers can prepend their own
 * via the `patterns` option; the consumer entries win.
 */
export const DEFAULT_ERROR_PATTERNS: readonly ErrorPattern[] = [
  // Gas / balance — should match before generic "execution reverted" because
  // these are more specific.
  { pattern: /insufficient funds/i, message: 'Insufficient funds for gas fees.' },
  { pattern: /gas required exceeds/i, message: 'Transaction requires more gas than allowed.' },

  // Replacement / nonce — single message because the user fix is identical
  // (wait or speed up the prior pending tx).
  {
    pattern: /could not replace existing tx|replacement transaction underpriced|nonce too low/i,
    message: 'A previous transaction is still pending. Please wait for it to confirm or speed it up in your wallet.',
  },

  // Network / RPC connectivity. "disconnected" before "could not detect" so
  // the more user-actionable copy wins.
  { pattern: /disconnected|not connected/i, message: 'Wallet disconnected. Please reconnect and try again.' },
  { pattern: /could not detect network|network changed/i, message: 'Network connection issue. Please check your wallet network.' },
  { pattern: /timeout|etimedout/i, message: 'Request timed out. Please try again.' },
  { pattern: /fetch failed|econnrefused|enotfound/i, message: 'Unable to reach the server. Please check your connection.' },

  // Rate limiting / service availability.
  { pattern: /\b429\b|too many requests/i, message: 'Too many requests. Please wait a moment and try again.' },
  { pattern: /\b503\b|service unavailable/i, message: 'Service temporarily unavailable. Please try again shortly.' },

  // Generic on-chain revert — last resort. Specific custom-error extraction
  // happens earlier in the pipeline, so reaching here means the revert
  // wasn't decoded.
  { pattern: /execution reverted/i, message: 'Transaction failed on-chain.' },
]

const DEFAULT_FALLBACK = 'Something went wrong. Please try again.'
const DEFAULT_REJECTION_COPY = 'Transaction was cancelled.'

/**
 * Convert a raw error into a short, user-friendly message safe to display.
 *
 * @example
 * ```ts
 * try {
 *   await client.signalIntent(params)
 * } catch (error) {
 *   const message = getUserFriendlyErrorMessage(error, {
 *     customErrors: { HashMismatch: 'The proof did not match the deposit.' },
 *   })
 *   showToast(message)
 * }
 * ```
 */
export function getUserFriendlyErrorMessage(
  error: unknown,
  options: {
    customErrors?: Record<string, string>
    patterns?: readonly ErrorPattern[]
    fallback?: string
  } = {},
): string {
  if (isUserRejectionError(error)) return DEFAULT_REJECTION_COPY

  const raw = stringifyError(error)
  const errorName = extractContractErrorName(error) ?? extractContractErrorNameFromMessage(raw)
  if (errorName !== null) {
    const friendly = options.customErrors?.[errorName]
    return friendly !== undefined
      ? `${friendly} (${errorName})`
      : `Transaction failed: ${humaniseErrorName(errorName)}.`
  }

  const consumerPatterns = options.patterns ?? []
  for (const { pattern, message } of consumerPatterns) {
    if (pattern.test(raw)) return message
  }
  for (const { pattern, message } of DEFAULT_ERROR_PATTERNS) {
    if (pattern.test(raw)) return message
  }

  return options.fallback ?? DEFAULT_FALLBACK
}

/** "PaymentVerificationFailed" → "Payment Verification Failed" */
function humaniseErrorName(name: string): string {
  return name.replace(/([A-Z])/g, ' $1').trim()
}

/** Normalise an unknown thrown value into a string for pattern matching. */
function stringifyError(error: unknown): string {
  if (error === null || error === undefined) return ''
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
