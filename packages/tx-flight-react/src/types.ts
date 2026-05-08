/**
 * @fileoverview Public + internal type surface for `@valve-tech/tx-flight-react`.
 *
 * Public types: the three add-input shapes (`AddWithWalletAdapterInput`,
 * `AddByHashInput`, `AddManualInput`), the `TxFlightStorage` adapter
 * contract, and provider/hook option bags.
 *
 * Internal types: `InternalState` (used by reducers + store) is exported
 * for cross-module use within the package but is NOT re-exported from
 * `index.ts` — consumers don't need it.
 *
 * wallet-adapter and viem types are imported as `type`-only so the
 * optional-peer-dep posture (spec §6.1) holds: a wallet-adapter-only
 * consumer doesn't pay any tx-tracker bundle cost, and a hash-only
 * consumer doesn't pay any wallet-adapter cost.
 */

import type { Hex, PublicClient } from 'viem'
import type {
  TrackedTx,
  TxFlow,
  WriteHookParams,
  WalletSendTransactionRequest,
} from '@valve-tech/wallet-adapter'

// ─── Re-export wallet-adapter types ─────────────────────────────────────────
//
// `index.ts` re-exports these so consumers who already import everything
// from `@valve-tech/tx-flight-react` see a self-contained surface. Runtime
// values like `TX_STATUS` / `TX_FLOW` are NOT re-exported — consumers who
// want them import directly from `@valve-tech/wallet-adapter`. Keeps the
// optional peer-dep posture honest.
export type { TrackedTx, TxFlow }

// ─── Add inputs ─────────────────────────────────────────────────────────────

/**
 * Input for `addWithWalletAdapter(input)`. Use when the caller is
 * submitting their tx via `sendTransactionWithHooks` from
 * `@valve-tech/wallet-adapter`. The strip wraps `hooks` so each phase
 * fans out to both the caller's original callbacks AND the strip's
 * store dispatch.
 */
export interface AddWithWalletAdapterInput {
  /** The hooks bag the consumer is already passing to sendTransactionWithHooks. */
  hooks: WriteHookParams
  /** Echoed onto TrackedTx.flow. Caller-defined string. */
  flow: TxFlow
  /** Echoed onto TrackedTx.chainId. */
  chainId: number
  /** Echoed onto TrackedTx.request — used for replay/replace flows. */
  request: WalletSendTransactionRequest
}

/**
 * Input for `addByHash(input)`. Use when the caller already has a tx
 * hash + chainId and a `PublicClient` to watch with. Internally builds
 * a private `ChainSource` + `TxTracker` pair (dynamic-imports
 * `@valve-tech/tx-tracker` + `@valve-tech/chain-source`).
 */
export interface AddByHashInput {
  hash: Hex
  chainId: number
  /** viem PublicClient pointed at the chain. */
  client: PublicClient
  flow?: TxFlow
  /** Confirmations before TrackedTx.status flips to mined. Default 1. */
  confirmations?: number
  /** Blocks of unseen observation before TrackedTx.status flips to dropped. Default 12. */
  staleAfterBlocks?: number
  /**
   * If true, fetches the receipt at inclusion. When the receipt's
   * status is reverted, the strip surfaces `failed`. Adds one RPC.
   */
  withReceipts?: boolean
}

/**
 * Input for `addManual(input)`. Use when the caller already has a
 * fully-formed `TrackedTx` (e.g., back-filling from a server push,
 * surfacing a tx observed elsewhere). The strip stores the entry
 * verbatim and does NOT auto-update — caller drives subsequent state
 * by calling `addManual` again with the same `tx.id` (overwrites in
 * place) or `remove(id)`.
 */
export interface AddManualInput {
  tx: TrackedTx
}

// ─── Storage adapter ────────────────────────────────────────────────────────

/**
 * Pluggable persistence contract for the tx-flight strip. The Provider
 * loads on mount and saves on state change (debounced ~250ms).
 *
 * Built-in adapters live at `@valve-tech/tx-flight-react/storage`:
 * `localStorageAdapter` (default), `indexedDBAdapter`, `memoryAdapter`.
 * Custom adapters just satisfy this two-method interface.
 */
export interface TxFlightStorage {
  /** Returns null if no entry exists for the given id. */
  load(id: string): Promise<TrackedTx[] | null>
  /** Replace stored value. Called debounced ~250ms by the Provider. */
  save(id: string, txs: TrackedTx[]): Promise<void>
}

// ─── Internal state ─────────────────────────────────────────────────────────
//
// Exported for cross-module use within the package (reducers, store,
// provider). NOT re-exported from `index.ts` — consumers shouldn't see
// this shape directly.

export interface InternalState {
  /** TrackedTx records keyed by their assigned id. */
  txs: ReadonlyMap<string, TrackedTx>
  /**
   * Per-tx unsubscribe handles for active watchers (addByHash spawns
   * one; addWithWalletAdapter and addManual leave this empty for the
   * tx). The reducers don't call these — the Provider does on remove
   * or unmount, keeping reducers pure.
   */
  watchers: ReadonlyMap<string, () => void>
}

export const emptyState: InternalState = {
  txs: new Map(),
  watchers: new Map(),
}
