'use client'

/**
 * @fileoverview `useTxFlight(id?)` — the consumer's entry point to a
 * Provider's store.
 *
 * Resolution order for the id:
 *   1. Explicit argument — `useTxFlight('settings-page')`.
 *   2. Ambient context from the nearest `<TxFlightProvider>`.
 *   3. Fallback `'default'`.
 *
 * Throws if no Provider has registered a store for the resolved id.
 *
 * For Task 5 the hook surface is `txs` + `addManual` + `remove` +
 * `clear` + `get`. The wallet-adapter (`addWithWalletAdapter`) and
 * tx-tracker (`addByHash`) integrations land in Tasks 7 and 8 and
 * extend this surface.
 */

import { useSyncExternalStore } from 'react'
import type { TrackedTx, WriteHookParams } from '@valve-tech/wallet-adapter'

import { addByHashImpl } from './integrations/tx-tracker.js'
import {
  addWithWalletAdapterImpl,
  type AddWithWalletAdapterResult,
} from './integrations/wallet-adapter.js'
import { _getStoreForId, _useTxFlightContext } from './provider.js'
import type {
  AddByHashInput,
  AddManualInput,
  AddWithWalletAdapterInput,
} from './types.js'

export interface UseTxFlightReturn {
  /** Reactive snapshot — re-renders when state changes. */
  txs: readonly TrackedTx[]
  /**
   * Add a tx the consumer is submitting via @valve-tech/wallet-adapter.
   * Returns the assigned id and a wrapped `WriteHookParams` to pass to
   * `sendTransactionWithHooks`. Each phase fans out to the consumer's
   * original callbacks AND a store dispatch reflecting the new state.
   */
  addWithWalletAdapter: (input: AddWithWalletAdapterInput) => AddWithWalletAdapterResult
  /**
   * Add a tx by its hash + chainId. Internally builds a private
   * ChainSource + TxTracker and watches the hash. Async because
   * `@valve-tech/tx-tracker` is dynamic-imported (optional peer dep).
   */
  addByHash: (input: AddByHashInput) => Promise<string>
  /** Add a fully-formed TrackedTx. Returns the supplied id. */
  addManual: (input: AddManualInput) => string
  /** Remove an entry by id. No-op if not found. */
  remove: (id: string) => void
  /** Empty the strip (terminal + non-terminal). */
  clear: () => void
  /** Imperative read; doesn't subscribe to re-renders. */
  get: (id: string) => TrackedTx | null
}

export type { WriteHookParams, AddWithWalletAdapterResult }

export const useTxFlight = (id?: string): UseTxFlightReturn => {
  const ambient = _useTxFlightContext()
  const resolvedId = id ?? ambient?.id ?? 'default'
  const store = _getStoreForId(resolvedId)
  if (!store) {
    throw new Error(
      `[@valve-tech/tx-flight-react] No <TxFlightProvider id="${resolvedId}"> found in tree`,
    )
  }

  const txs = useSyncExternalStore(store.subscribe, store.getTxs, store.getTxs)

  return {
    txs,
    addWithWalletAdapter: (input) => addWithWalletAdapterImpl(store, input),
    addByHash: (input) => addByHashImpl(store, input),
    addManual: (input) => {
      store.dispatch.addWithTx(input.tx, null)
      return input.tx.id
    },
    remove: (txId) => {
      store.dispatch.remove(txId)
    },
    clear: () => {
      store.dispatch.clear()
    },
    get: (txId) => store.getState().txs.get(txId) ?? null,
  }
}
