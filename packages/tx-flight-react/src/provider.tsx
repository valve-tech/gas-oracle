'use client'

/**
 * @fileoverview <TxFlightProvider> — wraps the React tree with a
 * tx-flight store, scoped by `id`.
 *
 * Lifecycle:
 *  - First render: lazy `useState` acquires (or reuses) a store
 *    registered under `id` in a module-level registry. Two Providers
 *    with the same `id` silently share the same store via refCount.
 *  - First commit: `useEffect` starts the side-effect machinery —
 *    eviction interval, debounced storage save subscription, storage
 *    rehydrate. Idempotent across same-id mounts via `entry.started`.
 *  - Unmount: `useEffect` cleanup decrements refCount; if 0, the
 *    entry is disposed (timers cleared, final save flushed) and
 *    removed from the registry.
 *
 * Why eager registration: the children's first render calls
 * `useTxFlight`, which throws if no store is registered for the id.
 * Lazy `useState` runs once per component instance and is safe to
 * mutate the registry from (no Strict-Mode double-invoke).
 *
 * SSR: `'use client'` keeps Next.js RSC from running this on the
 * server. Other SSR frameworks (renderToString) will reach the lazy
 * registration; that's acceptable for v0.9.0 because side effects
 * (timers, storage IO) are gated by `useEffect`. Task 12 audits the
 * surface for residual `window`/`document` access.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { PublicClient } from 'viem'

import { resumeByHashWatcher } from './integrations/tx-tracker.js'
import { localStorageAdapter } from './storage/local-storage.js'
import { createTxFlightStore, type TxFlightStore } from './store/store.js'
import type { TxFlightStorage } from './types.js'

export type TxFlightClientFactory = (chainId: number) => PublicClient | undefined

const DEFAULT_ID = 'default'
const DEFAULT_MAX_ITEMS = 50
const DEFAULT_TERMINAL_RETENTION_MS = 60_000
const DEFAULT_SAVE_DEBOUNCE_MS = 250
const DEFAULT_EVICT_INTERVAL_MS = 5_000

interface RegistryEntry {
  store: TxFlightStore
  refCount: number
  /** True after `startEntry` has run. Same-id mounts skip re-start. */
  started: boolean
  /** Replaced by `startEntry` once side effects are wired. */
  dispose: () => void
}

const registry = new Map<string, RegistryEntry>()

/** @internal — read by `useTxFlight` to find the store for an id. */
export const _getStoreForId = (id: string): TxFlightStore | undefined =>
  registry.get(id)?.store

/** @internal — test escape hatch; tears down every entry. */
export const _resetRegistry = (): void => {
  for (const entry of registry.values()) entry.dispose()
  registry.clear()
}

interface ContextValue {
  id: string
}

const TxFlightContext = createContext<ContextValue | null>(null)

/** @internal — read by `useTxFlight` to resolve the ambient id. */
export const _useTxFlightContext = (): ContextValue | null =>
  useContext(TxFlightContext)

export interface TxFlightProviderProps {
  children: ReactNode
  /** Scopes both in-memory state and storage key. Default: 'default'. */
  id?: string
  /**
   * Pluggable persistence. Pass `null` to disable persistence
   * (memory-only). Default: `localStorageAdapter()`.
   */
  storage?: TxFlightStorage | null
  /** Max retained entries before eviction prunes. Default: 50. */
  maxItems?: number
  /** How long terminals linger after settling (ms). Default: 60_000. */
  terminalRetentionMs?: number
  /** Surfaced for storage failures, watcher errors. */
  onError?: (method: string, err: unknown) => void
  /**
   * Optional. Returns a `PublicClient` for the given `chainId`, or
   * `undefined` if not configured. Required only if you want
   * persisted `pending` entries to auto-resume tx-tracker watching
   * after a reload. Without this, persisted `pending` entries stay
   * 'pending' until the consumer manually re-issues `addByHash`.
   */
  clientFactory?: TxFlightClientFactory
}

const startEntry = (
  id: string,
  entry: RegistryEntry,
  storage: TxFlightStorage | null,
  onError: ((method: string, err: unknown) => void) | undefined,
  clientFactory: TxFlightClientFactory | undefined,
): void => {
  // Idempotent restart: tear down any prior dispose (the placeholder
  // on a fresh entry, or a real teardown on a re-start). Keeps
  // startEntry safe to call more than once on the same entry.
  entry.dispose()

  const store = entry.store
  const evictTimer = setInterval(
    () => store.dispatch.evict(),
    DEFAULT_EVICT_INTERVAL_MS,
  )

  // No persistence: only the eviction tick.
  if (!storage) {
    entry.dispose = (): void => {
      clearInterval(evictTimer)
    }
    return
  }

  // Persistence: subscribe for debounced save, kick off rehydrate,
  // tear all of it down on dispose.
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const flushSave = (): void => {
    if (saveTimer === null) return
    clearTimeout(saveTimer)
    saveTimer = null
    storage.save(id, [...store.getTxs()]).catch((err) => {
      onError?.('storage-save', err)
    })
  }
  const unsubscribeStore = store.subscribe(() => {
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSave, DEFAULT_SAVE_DEBOUNCE_MS)
  })

  storage.load(id).then((loaded) => {
    if (loaded === null) return
    for (const tx of loaded) {
      if (store.getState().txs.has(tx.id)) continue
      // Pre-hash in-flight states cannot resume across a reload — the
      // wallet interaction is gone. Translate to a terminal failure
      // so the consumer's UI shows the loss honestly.
      if (tx.status === 'preparing' || tx.status === 'awaiting-signature') {
        store.dispatch.addWithTx(
          { ...tx, status: 'failed', notes: 'lost during reload' },
          null,
        )
        continue
      }
      // Default: seed the entry. For 'pending' with a hash + a
      // configured client, async-attach a tx-tracker watcher so the
      // entry continues advancing toward terminal.
      store.dispatch.addWithTx(tx, null)
      if (
        tx.status === 'pending' &&
        tx.hash !== undefined &&
        clientFactory !== undefined
      ) {
        const client = clientFactory(tx.chainId)
        if (client !== undefined) {
          // resumeByHashWatcher swallows its own failures into onError.
          void resumeByHashWatcher(store, tx, client, onError)
        }
      }
    }
  }).catch((err) => {
    onError?.('storage-load', err)
  })

  entry.dispose = (): void => {
    clearInterval(evictTimer)
    unsubscribeStore()
    flushSave()
  }
}

export const TxFlightProvider = (props: TxFlightProviderProps): ReactNode => {
  const id = props.id ?? DEFAULT_ID
  const maxItems = props.maxItems ?? DEFAULT_MAX_ITEMS
  const terminalRetentionMs = props.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS
  const onError = props.onError
  const clientFactory = props.clientFactory
  const storage = props.storage === null
    ? null
    : (props.storage ?? localStorageAdapter())

  // Eager: claim a registry entry on first render so children that
  // call `useTxFlight` in their FIRST render see a valid store. Lazy
  // `useState` initializers run once per component instance and are
  // safe to perform a single registration side effect from.
  //
  // refCount is owned by `useEffect` (commit phase). Render-phase
  // registration leaves refCount at 0; the effect bumps it.
  useState<RegistryEntry>(() => {
    const existing = registry.get(id)
    if (existing) return existing
    const store = createTxFlightStore({ maxItems, terminalRetentionMs, onError })
    const fresh: RegistryEntry = {
      store,
      refCount: 0,
      started: false,
      dispose: () => undefined,
    }
    registry.set(id, fresh)
    return fresh
  })

  useEffect(() => {
    // The render-phase entry may be missing on this commit if a Strict
    // Mode dev cycle disposed it between setup runs (or a test reset
    // ran). Re-create so children's hooks keep working.
    let entry = registry.get(id)
    if (!entry) {
      const store = createTxFlightStore({ maxItems, terminalRetentionMs, onError })
      entry = {
        store,
        refCount: 0,
        started: false,
        dispose: () => undefined,
      }
      registry.set(id, entry)
    }
    entry.refCount += 1
    if (!entry.started) {
      entry.started = true
      startEntry(id, entry, storage, onError, clientFactory)
    }
    // Capture in closure so cleanup uses the entry this commit
    // claimed, not whatever happens to be in the registry later.
    const captured = entry
    return () => {
      captured.refCount -= 1
      if (captured.refCount > 0) return
      captured.dispose()
      // Only clear our slot. A test reset may have replaced the entry.
      if (registry.get(id) === captured) registry.delete(id)
    }
  }, [id, storage, maxItems, terminalRetentionMs, onError, clientFactory])

  return (
    <TxFlightContext.Provider value={{ id }}>
      {props.children}
    </TxFlightContext.Provider>
  )
}
