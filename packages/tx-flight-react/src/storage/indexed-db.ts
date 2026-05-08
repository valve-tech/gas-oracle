/**
 * @fileoverview IndexedDB adapter — opt-in for consumers who outgrow
 * localStorage's ~5MB cap or need cross-tab persistence with structured
 * data. Async by nature.
 *
 * One database, one object store. Records are keyed by the Provider's
 * `id`; each record stores the serialized JSON string (same format as
 * the localStorage adapter, see `serialize.ts`).
 *
 * SSR-safe: when `globalThis.indexedDB === undefined`, `load` resolves
 * null and `save` resolves no-op.
 */

import type { TrackedTx } from '@valve-tech/wallet-adapter'

import type { TxFlightStorage } from '../types.js'
import { serialize, deserialize } from './serialize.js'

export interface IndexedDBAdapterOptions {
  /** Database name. Default: 'tx-flight'. */
  dbName?: string
  /** Object store name. Default: 'flights'. */
  storeName?: string
}

const getIndexedDB = (): IDBFactory | null => {
  if (typeof globalThis.indexedDB === 'undefined') return null
  return globalThis.indexedDB
}

const openDb = (
  factory: IDBFactory,
  dbName: string,
  storeName: string,
): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = factory.open(dbName, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const promisifyRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

export const indexedDBAdapter = (
  options: IndexedDBAdapterOptions = {},
): TxFlightStorage => {
  const dbName = options.dbName ?? 'tx-flight'
  const storeName = options.storeName ?? 'flights'
  return {
    load: async (id): Promise<TrackedTx[] | null> => {
      const factory = getIndexedDB()
      if (!factory) return null
      const db = await openDb(factory, dbName, storeName)
      const tx = db.transaction(storeName, 'readonly')
      const raw = await promisifyRequest(tx.objectStore(storeName).get(id))
      db.close()
      if (typeof raw !== 'string') return null
      return deserialize(raw)
    },
    save: async (id, txs): Promise<void> => {
      const factory = getIndexedDB()
      if (!factory) return
      const db = await openDb(factory, dbName, storeName)
      const tx = db.transaction(storeName, 'readwrite')
      await promisifyRequest(tx.objectStore(storeName).put(serialize(txs), id))
      db.close()
    },
  }
}
