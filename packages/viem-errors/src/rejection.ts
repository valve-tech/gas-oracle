/**
 * @fileoverview Detect a user-initiated wallet rejection.
 *
 * Wallet UX needs to distinguish *I cancelled* from *something failed*.
 * The two surfaces look superficially similar — both throw, both reach
 * `catch` blocks — but they call for different UI: rejection → reset to
 * idle, real failure → show error message and offer retry.
 *
 * The challenge: rejection text varies by wallet, locale, and error
 * version (`User rejected the request`, `user cancelled`, `User denied
 * transaction signature`, `User disapproved`, etc.). Top-level
 * `.message` matching alone is fragile because viem nests the actual
 * rejection several layers deep — the wrapper's message reads
 * `Failed to send transaction`, which would otherwise look like a
 * generic failure and get the wrong UI.
 */

import { walkErrorCause } from './walk.js'

/** Toast-friendly message shown when the user rejects a wallet prompt. */
export const USER_REJECTION_MESSAGE = 'Transaction was rejected in wallet.'

/**
 * Wallet-rejection text varies by wallet/locale ("User rejected the request",
 * "user cancelled", "User denied transaction signature", …) so message
 * matching alone is fragile. Order: most-common viem/MetaMask phrasing first.
 */
const REJECTION_MESSAGE_PATTERN = /user rejected|user denied|rejected the request|user cancelled|user canceled|user disapproved/i

/**
 * Check whether an error represents a user-initiated wallet rejection.
 *
 * Walks the cause chain (viem nests rejections several layers deep —
 * typically `ContractFunctionExecutionError` → `RpcRequestError` →
 * `UserRejectedRequestError`) and checks three independent signals at
 * each level:
 *   1. **EIP-1193 `code === 4001`** — the spec-mandated rejection code,
 *      language-independent. The most reliable signal when present.
 *   2. **Error name `UserRejectedRequestError`** — viem's class name.
 *   3. **Message text regex** — fallback for wallets that bypass the
 *      standard error class.
 *
 * Any one of those three is sufficient at any level in the chain.
 */
export function isUserRejectionError(error: unknown): boolean {
  for (const link of walkErrorCause(error)) {
    if (link === null || link === undefined) continue
    if (typeof link === 'string') {
      if (REJECTION_MESSAGE_PATTERN.test(link)) return true
      continue
    }
    if (typeof link !== 'object') continue

    const node = link as { code?: unknown; name?: unknown; message?: unknown }
    if (node.code === 4001) return true
    if (typeof node.name === 'string' && node.name === 'UserRejectedRequestError') return true
    if (typeof node.message === 'string' && REJECTION_MESSAGE_PATTERN.test(node.message)) return true
  }
  return false
}
