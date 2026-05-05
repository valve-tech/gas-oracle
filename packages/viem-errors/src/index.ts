/**
 * @fileoverview Public API of `@valve-tech/viem-errors`.
 */

export { walkErrorCause } from './walk.js'
export { isUserRejectionError, USER_REJECTION_MESSAGE } from './rejection.js'
export { extractContractErrorName, extractContractErrorNameFromMessage } from './contract-error.js'
export {
  getUserFriendlyErrorMessage,
  DEFAULT_ERROR_PATTERNS,
  type ErrorPattern,
} from './messages.js'
export { handleWalletError, type HandleWalletErrorOptions } from './handle.js'
