/**
 * @fileoverview localStorage adapter — the default persistence path.
 *
 * Storage key: `${keyPrefix}:${id}`, default `tx-flight:default`.
 * SSR-safe: when `globalThis.window === undefined`, `load` resolves
 * null and `save` resolves no-op (no throw). Hydration on the client
 * picks up the persisted state.
 *
 * The Provider debounces calls to `save` (~250ms), so the
 * sync-write-on-every-keystroke concern doesn't apply here.
 */

import type { TrackedTx } from '@valve-tech/wallet-adapter'

import type { TxFlightStorage } from '../types.js'
import { serialize, deserialize } from './serialize.js'

export interface LocalStorageAdapterOptions {
  /** Storage key prefix. Default: 'tx-flight'. */
  keyPrefix?: string
}

const getStorage = (): Storage | null => {
  if (typeof globalThis.window === 'undefined') return null
  return globalThis.window.localStorage
}

export const localStorageAdapter = (
  options: LocalStorageAdapterOptions = {},
): TxFlightStorage => {
  const prefix = options.keyPrefix ?? 'tx-flight'
  const keyOf = (id: string): string => `${prefix}:${id}`
  return {
    load: async (id): Promise<TrackedTx[] | null> => {
      const storage = getStorage()
      if (!storage) return null
      const raw = storage.getItem(keyOf(id))
      if (raw === null) return null
      return deserialize(raw)
    },
    save: async (id, txs): Promise<void> => {
      const storage = getStorage()
      if (!storage) return
      storage.setItem(keyOf(id), serialize(txs))
    },
  }
}
