/**
 * @fileoverview Public API of `@valve-tech/tx-flight-react`.
 *
 * Public surface lands progressively across tasks 2-12 of
 * `docs/superpowers/plans/2026-05-07-tx-flight-react.md`. This file
 * is the single entrypoint; storage adapters live at the
 * `./storage` sub-export.
 */

// ─── Type-only re-exports ──────────────────────────────────────────────────

export type {
  AddWithWalletAdapterInput,
  AddByHashInput,
  AddManualInput,
  TxFlightStorage,
  TrackedTx,
  TxFlow,
} from './types.js'

// ─── Provider + hook ───────────────────────────────────────────────────────

export {
  TxFlightProvider,
  type TxFlightProviderProps,
} from './provider.js'

export { useTxFlight, type UseTxFlightReturn } from './use-tx-flight.js'

// ─── Components ────────────────────────────────────────────────────────────

export {
  TxFlightStatusIcon,
  type TxFlightStatusIconProps,
} from './components/status-icon.js'
export {
  TxFlightHashLink,
  type TxFlightHashLinkProps,
  type HashTruncate,
} from './components/hash-link.js'
export { TxFlightAge, type TxFlightAgeProps } from './components/age.js'
export {
  TxFlightActions,
  type TxFlightActionsProps,
  type TxFlightActionsShow,
} from './components/actions.js'
export {
  TxFlightItem,
  type TxFlightItemProps,
  type TxFlightItemRenderParts,
} from './components/item.js'
export { TxFlightList, type TxFlightListProps } from './components/list.js'
