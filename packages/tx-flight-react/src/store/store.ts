/**
 * @fileoverview Subscribable store wrapping the pure reducers with the
 * side effects the Provider needs:
 *
 *  - notify subscribers on state change (so React's
 *    `useSyncExternalStore` re-renders consumers)
 *  - call watcher unsub on remove / clear / evict / overwrite (the
 *    reducers are forbidden from doing this — see AGENTS.md invariant 1)
 *  - cache the txs-as-array projection so `useSyncExternalStore` sees
 *    a stable reference between dispatches
 *
 * Storage IO and the eviction `setInterval` belong in the Provider,
 * not here. The store exposes `dispatch.evict()` so the Provider can
 * invoke it on its own schedule (testable + composable).
 */

import type { TrackedTx } from '@valve-tech/wallet-adapter'

import type { InternalState } from '../types.js'
import {
  addReducer,
  evictReducer,
  removeReducer,
  updateReducer,
} from './reducers.js'

export interface TxFlightStoreOptions {
  /** Cap on retained entries. Eviction tick prunes terminals first, then non-terminals if still over. */
  maxItems: number
  /** How long terminals linger before eviction. */
  terminalRetentionMs: number
  /**
   * Routed for watcher-unsub failures. Storage errors come from the
   * Provider, not the store. Optional — undefined silently swallows.
   */
  onError?: (method: string, err: unknown) => void
}

export interface TxFlightStore {
  getState(): InternalState
  /** Stable-reference array projection of txs. Recomputed only on state change. */
  getTxs(): readonly TrackedTx[]
  subscribe(listener: () => void): () => void
  dispatch: {
    /**
     * Insert (or overwrite) a TrackedTx with an optional watcher unsub.
     * If a prior watcher was registered for the same `tx.id`, it is
     * unsubscribed BEFORE the state changes — so its in-flight callbacks
     * cannot pollute the new entry.
     */
    addWithTx: (tx: TrackedTx, watcher: (() => void) | null) => void
    update: (txId: string, patch: Partial<TrackedTx>) => void
    /** Remove a tx + its watcher. Calls the watcher's unsub before state changes. */
    remove: (txId: string) => void
    /** Empty the store. Calls every watcher's unsub before state changes. */
    clear: () => void
    /**
     * Periodic eviction tick. Calls `evictReducer` with `Date.now()`;
     * when the resulting state drops txs that had watchers, those
     * watchers are unsubscribed.
     */
    evict: () => void
  }
}

const emptyInternalState = (): InternalState => ({
  txs: new Map(),
  watchers: new Map(),
})

export const createTxFlightStore = (
  options: TxFlightStoreOptions,
): TxFlightStore => {
  let state: InternalState = emptyInternalState()
  let cachedTxs: readonly TrackedTx[] | null = null
  const listeners = new Set<() => void>()

  const safeUnsub = (unsub: () => void): void => {
    try {
      unsub()
    } catch (err) {
      options.onError?.('watcher-unsub', err)
    }
  }

  const setState = (next: InternalState): void => {
    if (next === state) return
    state = next
    cachedTxs = null
    for (const fn of listeners) fn()
  }

  return {
    getState: () => state,
    getTxs: () => {
      if (cachedTxs === null) cachedTxs = Array.from(state.txs.values())
      return cachedTxs
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispatch: {
      addWithTx: (tx, watcher) => {
        const priorUnsub = state.watchers.get(tx.id)
        if (priorUnsub) safeUnsub(priorUnsub)
        setState(addReducer(state, tx, watcher))
      },
      update: (txId, patch) => {
        setState(updateReducer(state, txId, patch, Date.now()))
      },
      remove: (txId) => {
        const unsub = state.watchers.get(txId)
        if (unsub) safeUnsub(unsub)
        setState(removeReducer(state, txId))
      },
      clear: () => {
        const unsubs = Array.from(state.watchers.values())
        for (const unsub of unsubs) safeUnsub(unsub)
        setState(emptyInternalState())
      },
      evict: () => {
        const next = evictReducer(state, {
          maxItems: options.maxItems,
          terminalRetentionMs: options.terminalRetentionMs,
          now: Date.now(),
        })
        if (next === state) return
        for (const [id, unsub] of state.watchers) {
          if (!next.watchers.has(id)) safeUnsub(unsub)
        }
        setState(next)
      },
    },
  }
}
