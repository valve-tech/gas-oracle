/**
 * @fileoverview Public API of `@valve-tech/wallet-adapter`.
 */

export type {
  WalletAdapter,
  WalletSendTransactionRequest,
  WalletReadContractRequest,
} from './wallet.js'

export type { WriteHookParams } from './hooks.js'

export {
  TX_STATUS,
  TX_FLOW,
  STALE_TX_AGE_MS,
  CONFIRMED_DISPLAY_MS,
  FAILED_DISPLAY_MS,
} from './tx-status.js'

export type {
  TrackedTx,
  TrackedTxGas,
  TrackedTxStatus,
  TxFlow,
  TxConfirmedCallback,
} from './tx-status.js'

export {
  sendTransactionWithHooks,
  WalletRejectedError,
  type SendTransactionWithHooksOptions,
} from './send.js'
