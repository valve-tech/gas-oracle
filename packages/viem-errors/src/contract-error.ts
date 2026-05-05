/**
 * @fileoverview Extract the decoded custom Solidity error name from a viem
 * revert error.
 *
 * viem's `ContractFunctionRevertedError` exposes
 * `data: { errorName, args, ... }` for decoded custom errors when the ABI
 * is supplied. The decoded name is what the UI actually wants to surface
 * ("HashMismatch" or "InsufficientDepositLiquidity") — much more useful
 * than the wrapper's generic "execution reverted" text.
 *
 * The hard part is that viem's `data` field can sit several layers deep
 * in the cause chain — sometimes flattened across an RPC boundary. We
 * provide both a structured walk (`extractContractErrorName`) and a
 * message-scraping fallback (`extractContractErrorNameFromMessage`) for
 * the case where the cause chain has been collapsed.
 */

import { walkErrorCause } from './walk.js'

/**
 * Solidity custom error names start with an uppercase ASCII letter and
 * contain only ASCII letters, digits, and underscores. Anything outside
 * that pattern is rejected to avoid false positives — `data` fields named
 * `errorName` exist on a few non-revert error shapes too.
 */
const ERROR_NAME_PATTERN = /^[A-Z][A-Za-z0-9_]*$/

/**
 * Walk the cause chain and return the first valid Solidity error name found
 * on `data.errorName`. Returns null if no such name is present.
 *
 * @example
 * ```ts
 * const name = extractContractErrorName(error)
 * if (name) {
 *   showFriendlyMessage(name)
 * }
 * ```
 */
export function extractContractErrorName(error: unknown): string | null {
  for (const link of walkErrorCause(error)) {
    if (link === null || link === undefined || typeof link !== 'object') continue
    const data = (link as { data?: unknown }).data
    if (data === null || data === undefined || typeof data !== 'object') continue
    const name = (data as { errorName?: unknown }).errorName
    if (typeof name !== 'string') continue
    if (!ERROR_NAME_PATTERN.test(name)) continue
    return name
  }
  return null
}

/**
 * Fall back to scraping viem's stringified message when the cause chain has
 * been flattened (e.g. across an RPC boundary or after JSON round-tripping).
 * Matches the literal "reverted with the following reason:\n<ErrorName>"
 * shape viem produces.
 */
export function extractContractErrorNameFromMessage(raw: string): string | null {
  if (raw.length === 0) return null
  const match = raw.match(/reverted with the following reason:\s*\n?\s*([A-Z][A-Za-z0-9_]*)\(?/)
  return match?.[1] ?? null
}
