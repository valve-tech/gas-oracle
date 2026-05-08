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
