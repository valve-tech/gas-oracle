import { test, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { indexedDBAdapter } from './indexed-db.js'

const sample = (id: string): TrackedTx => ({
  id,
  chainId: 1,
  flow: 'send',
  submittedAt: 1,
  submittedTier: 'standard',
  status: 'pending',
})

beforeEach(() => {
  // Reset the in-memory IndexedDB between tests.
  globalThis.indexedDB = new IDBFactory()
})

test('indexedDBAdapter returns null when no record exists', async () => {
  const adapter = indexedDBAdapter()
  expect(await adapter.load('default')).toBeNull()
})

test('indexedDBAdapter round-trips a stored value', async () => {
  const adapter = indexedDBAdapter()
  const txs = [sample('tx-1'), sample('tx-2')]
  await adapter.save('default', txs)
  expect(await adapter.load('default')).toEqual(txs)
})

test('indexedDBAdapter scopes by id', async () => {
  const adapter = indexedDBAdapter()
  await adapter.save('a', [sample('tx-1')])
  await adapter.save('b', [sample('tx-2')])
  expect(await adapter.load('a')).toEqual([sample('tx-1')])
  expect(await adapter.load('b')).toEqual([sample('tx-2')])
})

test('indexedDBAdapter respects custom dbName + storeName', async () => {
  const adapter = indexedDBAdapter({ dbName: 'custom-db', storeName: 'custom-store' })
  await adapter.save('default', [sample('tx-1')])
  expect(await adapter.load('default')).toEqual([sample('tx-1')])
})

test('indexedDBAdapter persists bigint fields under submittedGas', async () => {
  const adapter = indexedDBAdapter()
  const txs: TrackedTx[] = [
    {
      ...sample('tx-1'),
      submittedGas: {
        maxFeePerGas: 100_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      },
    },
  ]
  await adapter.save('default', txs)
  const out = await adapter.load('default')
  expect(out?.[0]?.submittedGas?.maxFeePerGas).toBe(100_000_000_000n)
})

// ─── onerror paths ─────────────────────────────────────────────────────────
//
// fake-indexeddb's happy path covers onsuccess; onerror only fires for
// IDB-level failures. To exercise those branches, swap in a stub
// IDBFactory whose request immediately dispatches an error.

const makeOpenErrorFactory = (): IDBFactory => ({
  open: ((): IDBOpenDBRequest => {
    const req = {
      error: new DOMException('open failed', 'UnknownError'),
      onerror: null as ((this: IDBRequest, ev: Event) => unknown) | null,
      onsuccess: null,
      onupgradeneeded: null,
    } as unknown as IDBOpenDBRequest
    queueMicrotask(() => {
      req.onerror?.call(req, new Event('error'))
    })
    return req
  }) as IDBFactory['open'],
} as unknown as IDBFactory)

test('indexedDBAdapter.load rejects when openDb errors', async () => {
  globalThis.indexedDB = makeOpenErrorFactory()
  const adapter = indexedDBAdapter()
  await expect(adapter.load('default')).rejects.toThrow(/open failed/)
})

test('indexedDBAdapter.save rejects when openDb errors', async () => {
  globalThis.indexedDB = makeOpenErrorFactory()
  const adapter = indexedDBAdapter()
  await expect(adapter.save('default', [sample('tx-1')])).rejects.toThrow(/open failed/)
})

// Stub IDBFactory that returns a database whose objectStore.put always
// fires an error event. Used to cover the onerror branch of
// `promisifyRequest` without needing a real failing IDB op.
const makePutErrorFactory = (): IDBFactory => {
  const stubObjectStore = {
    put: () => {
      const req = {
        error: new DOMException('put failed', 'UnknownError'),
        onerror: null as ((this: IDBRequest, ev: Event) => unknown) | null,
        onsuccess: null,
      } as unknown as IDBRequest
      queueMicrotask(() => req.onerror?.call(req, new Event('error')))
      return req
    },
  } as unknown as IDBObjectStore
  const stubTransaction = {
    objectStore: () => stubObjectStore,
  } as unknown as IDBTransaction
  const stubDb = {
    transaction: () => stubTransaction,
    close: () => {},
    createObjectStore: () => stubObjectStore,
  } as unknown as IDBDatabase
  return {
    open: (() => {
      const req = {
        result: stubDb,
        onerror: null,
        onsuccess: null as ((this: IDBRequest, ev: Event) => unknown) | null,
        onupgradeneeded: null,
      } as unknown as IDBOpenDBRequest
      queueMicrotask(() => req.onsuccess?.call(req, new Event('success')))
      return req
    }) as IDBFactory['open'],
  } as unknown as IDBFactory
}

test('indexedDBAdapter.save rejects when objectStore.put errors', async () => {
  globalThis.indexedDB = makePutErrorFactory()
  const adapter = indexedDBAdapter()
  await expect(adapter.save('default', [sample('tx-1')])).rejects.toThrow(/put failed/)
})
