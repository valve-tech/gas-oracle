/**
 * Tests for the first-party `createLocalStorageTrackerStore`. Run
 * against an in-memory `Storage`-shaped fake so they don't depend on
 * a real DOM `localStorage`. Coverage focus:
 *
 *   - bigint round-trip via the SENTINEL replacer/reviver
 *   - `delete()` clears BOTH the record and the eventlog
 *     (the canonical bug class that motivated this first-party store)
 *   - `cleanupLegacyPrefixes` removes prior-prefix keys without
 *     touching live keys
 *   - `listDurable` filters by chain + eventlog-prefix rejection
 *   - `appendEvent` caps to `eventLogCapacity` (oldest dropped)
 *   - `readEventLog` with the `since` filter
 *   - missing `keyPrefix` throws at construction
 *   - missing `globalThis.localStorage` + no `storage` override throws
 *   - corrupt JSON returns null rather than crashing
 */

import { describe, expect, test, vi } from 'vitest'

import { buildSeenInBlock } from './events.js'
import {
  createLocalStorageTrackerStore,
  deleteKeysStartingWith,
  type LocalStorageLike,
} from './local-storage-store.js'
import type { TrackedTxRecord, TxTrackerStore } from './store.js'

// ---------- in-memory Storage fake ----------

const makeFakeStorage = (): LocalStorageLike & {
  _dump: () => Record<string, string>
  _set: (k: string, v: string) => void
} => {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
    get length() {
      return map.size
    },
    key: (i) => {
      const keys = [...map.keys()]
      return i < keys.length ? keys[i] : null
    },
    _dump: () => Object.fromEntries(map.entries()),
    _set: (k, v) => map.set(k, v),
  }
}

// ---------- record fixtures ----------

const makeRecord = (
  overrides: Partial<TrackedTxRecord> = {},
): TrackedTxRecord => ({
  chainId: 1,
  hash: '0xabc',
  status: {
    hash: '0xabc',
    chainId: 1,
    lastSeenInBlock: null,
    lastSeenInMempool: null,
    replacedBy: null,
    vanishedAt: null,
    unseenStreak: 0,
    firstObservedAtBlock: null,
    lastObservedAtBlock: null,
    terminalAtBlockNumber: null,
    capabilities: {
      newHeads: 'subscription',
      newPendingTransactions: 'poll-only',
      txpoolContent: 'available',
      receiptByHash: 'available',
      reprobeOnReconnect: true,
    },
  },
  firstSeenBlockNumber: 10n,
  lastObservedBlockNumber: 10n,
  retentionExpiresAtBlockNumber: 74n,
  subscriptions: [
    {
      id: 'sub-1',
      durable: true,
      selector: { kind: 'hash', hash: '0xabc' },
    },
  ],
  ...overrides,
})

// ---------- tests ----------

test('put + get round-trips a record with bigint fields losslessly', async () => {
  const storage = makeFakeStorage()
  const store = createLocalStorageTrackerStore({
    keyPrefix: 'p',
    storage,
  })
  const original = makeRecord({
    status: {
      ...makeRecord().status,
      lastSeenInBlock: {
        blockHash: '0xb1',
        blockNumber: 0xdeadbeefn,
        transactionIndex: 3,
        confirmations: 5,
        source: 'block-poll',
      },
      firstObservedAtBlock: 100n,
      lastObservedAtBlock: 105n,
    },
  })
  await store.put(original)
  const round = await store.get(1, '0xabc')
  expect(round).not.toBeNull()
  expect(round!.status.lastSeenInBlock?.blockNumber).toBe(0xdeadbeefn)
  expect(typeof round!.status.lastSeenInBlock?.blockNumber).toBe('bigint')
  expect(round!.status.firstObservedAtBlock).toBe(100n)
  expect(round!.retentionExpiresAtBlockNumber).toBe(74n)
})

test('delete removes BOTH the record key AND the eventlog key', async () => {
  const storage = makeFakeStorage()
  const store = createLocalStorageTrackerStore({
    keyPrefix: 'p',
    storage,
  })
  await store.put(makeRecord())
  await store.appendEvent(
    1,
    '0xabc',
    buildSeenInBlock({
      hash: '0xabc',
      chainId: 1,
      source: 'block-poll',
      at: { blockNumber: 100n, timestamp: 0n },
      blockHash: '0xb1',
      blockNumber: 100n,
      transactionIndex: 0,
      confirmations: 1,
    }),
  )
  // Both keys present.
  expect(storage.getItem('p:1:0xabc')).not.toBeNull()
  expect(storage.getItem('p:eventlog:1:0xabc')).not.toBeNull()
  // Delete clears both.
  await store.delete(1, '0xabc')
  expect(storage.getItem('p:1:0xabc')).toBeNull()
  expect(storage.getItem('p:eventlog:1:0xabc')).toBeNull()
})

test('listDurable returns durable records for the chain only', async () => {
  const storage = makeFakeStorage()
  const store = createLocalStorageTrackerStore({
    keyPrefix: 'p',
    storage,
  })
  // Chain 1, durable
  await store.put(makeRecord({ hash: '0xd1' }))
  // Chain 1, non-durable
  await store.put(
    makeRecord({
      hash: '0xn1',
      subscriptions: [
        {
          id: 'sub-2',
          durable: false,
          selector: { kind: 'hash', hash: '0xn1' },
        },
      ],
    }),
  )
  // Chain 2, durable
  await store.put(makeRecord({ chainId: 2, hash: '0xd2' }))

  const chain1 = await store.listDurable(1)
  expect(chain1.map((r) => r.hash).sort()).toEqual(['0xd1'])
  const chain2 = await store.listDurable(2)
  expect(chain2.map((r) => r.hash)).toEqual(['0xd2'])
})

test('listDurable skips records whose JSON is corrupt', async () => {
  const storage = makeFakeStorage()
  storage._set('p:1:0xbad', 'not-valid-json{{{')
  const store = createLocalStorageTrackerStore({
    keyPrefix: 'p',
    storage,
  })
  // No throw; corrupt entry just doesn't appear.
  const result = await store.listDurable(1)
  expect(result).toEqual([])
})

test('appendEvent caps the eventlog at eventLogCapacity (oldest dropped)', async () => {
  const storage = makeFakeStorage()
  const store = createLocalStorageTrackerStore({
    keyPrefix: 'p',
    storage,
    eventLogCapacity: 3,
  })
  for (let i = 0; i < 5; i++) {
    await store.appendEvent(
      1,
      '0xabc',
      buildSeenInBlock({
        hash: '0xabc',
        chainId: 1,
        source: 'block-poll',
        at: { blockNumber: BigInt(i + 1), timestamp: 0n },
        blockHash: `0xb${i}`,
        blockNumber: BigInt(i + 1),
        transactionIndex: 0,
        confirmations: 1,
      }),
    )
  }
  const log = await store.readEventLog!(1, '0xabc')
  expect(log).toHaveLength(3)
  // Oldest two dropped — entries 2, 3, 4 remain (blockNumbers 3, 4, 5).
  expect(log.map((e) => e.at.blockNumber)).toEqual([3n, 4n, 5n])
})

test('readEventLog with `since` filters by at.blockNumber', async () => {
  const storage = makeFakeStorage()
  const store = createLocalStorageTrackerStore({
    keyPrefix: 'p',
    storage,
  })
  for (let i = 1; i <= 5; i++) {
    await store.appendEvent(
      1,
      '0xabc',
      buildSeenInBlock({
        hash: '0xabc',
        chainId: 1,
        source: 'block-poll',
        at: { blockNumber: BigInt(i * 10), timestamp: 0n },
        blockHash: `0xb${i}`,
        blockNumber: BigInt(i * 10),
        transactionIndex: 0,
        confirmations: i,
      }),
    )
  }
  const recent = await store.readEventLog!(1, '0xabc', 30n)
  // Block numbers >= 30: 30, 40, 50
  expect(recent.map((e) => e.at.blockNumber)).toEqual([30n, 40n, 50n])
})

test('cleanupLegacyPrefixes removes old prefix keys, leaves current ones', async () => {
  const storage = makeFakeStorage()
  storage._set('old:1:0xa', '{"chainId":1}')
  storage._set('old:1:0xb', '{"chainId":1}')
  storage._set('p:1:0xkeep', '{"chainId":1}')
  createLocalStorageTrackerStore({
    keyPrefix: 'p',
    storage,
    cleanupLegacyPrefixes: ['old'],
  })
  const dump = storage._dump()
  expect(Object.keys(dump).sort()).toEqual(['p:1:0xkeep'])
})

test('cleanupLegacyPrefixes refuses to wipe the current prefix even if passed', async () => {
  const storage = makeFakeStorage()
  storage._set('p:1:0xlive', '{"chainId":1}')
  createLocalStorageTrackerStore({
    keyPrefix: 'p',
    storage,
    // Defensively passing the current prefix should NOT wipe live state.
    cleanupLegacyPrefixes: ['p'],
  })
  expect(storage.getItem('p:1:0xlive')).not.toBeNull()
})

test('cleanupLegacyPrefixes ignores empty-string entries', async () => {
  const storage = makeFakeStorage()
  storage._set('something', 'present')
  createLocalStorageTrackerStore({
    keyPrefix: 'p',
    storage,
    cleanupLegacyPrefixes: [''],
  })
  expect(storage.getItem('something')).not.toBeNull()
})

test('deleteKeysStartingWith deletes only matching keys', () => {
  const storage = makeFakeStorage()
  storage._set('a:1', 'x')
  storage._set('a:2', 'x')
  storage._set('b:1', 'x')
  deleteKeysStartingWith(storage, 'a:')
  expect(Object.keys(storage._dump()).sort()).toEqual(['b:1'])
})

test('deleteKeysStartingWith with empty prefix is a no-op (would otherwise wipe everything)', () => {
  const storage = makeFakeStorage()
  storage._set('a:1', 'x')
  storage._set('b:1', 'x')
  deleteKeysStartingWith(storage, '')
  expect(Object.keys(storage._dump()).sort()).toEqual(['a:1', 'b:1'])
})

test('keyPrefix is required', () => {
  const storage = makeFakeStorage()
  expect(() =>
    createLocalStorageTrackerStore({
      keyPrefix: '',
      storage,
    }),
  ).toThrow(/keyPrefix is required/)
})

test('throws when no storage is supplied and globalThis.localStorage is unavailable', () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage
  try {
    delete (globalThis as { localStorage?: unknown }).localStorage
    expect(() =>
      createLocalStorageTrackerStore({ keyPrefix: 'p' }),
    ).toThrow(/no `storage` supplied/)
  } finally {
    if (original !== undefined) {
      ;(globalThis as { localStorage: unknown }).localStorage = original
    }
  }
})

test('uses globalThis.localStorage when no override is supplied', async () => {
  // Inject a fake onto globalThis briefly to exercise the
  // auto-detection branch.
  const fake = makeFakeStorage()
  const original = (globalThis as { localStorage?: unknown }).localStorage
  ;(globalThis as { localStorage: unknown }).localStorage = fake
  try {
    const store = createLocalStorageTrackerStore({ keyPrefix: 'p' })
    await store.put(makeRecord())
    expect(fake.getItem('p:1:0xabc')).not.toBeNull()
  } finally {
    if (original === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage
    } else {
      ;(globalThis as { localStorage: unknown }).localStorage = original
    }
  }
})

test('get returns null for missing key', async () => {
  const storage = makeFakeStorage()
  const store = createLocalStorageTrackerStore({ keyPrefix: 'p', storage })
  expect(await store.get(1, '0xmissing')).toBeNull()
})

test('get returns null for corrupt JSON rather than throwing', async () => {
  const storage = makeFakeStorage()
  storage._set('p:1:0xbad', 'not-valid-json{{{')
  const store = createLocalStorageTrackerStore({ keyPrefix: 'p', storage })
  expect(await store.get(1, '0xbad')).toBeNull()
})

test('bigint reviver tolerates malformed sentinel without throwing', async () => {
  // Defensive: if the SENTINEL value was somehow ever non-numeric
  // (corruption, mis-migration), the reviver should hand back the raw
  // object rather than throw. Downstream code uses `typeof === 'bigint'`
  // guards so the returned object becomes a no-op.
  const storage = makeFakeStorage()
  storage._set(
    'p:1:0xbroken',
    '{"chainId":1,"hash":"0xbroken","status":{},"firstSeenBlockNumber":{"$tx-tracker:bigint":"not-a-number"},"lastObservedBlockNumber":0,"retentionExpiresAtBlockNumber":0,"subscriptions":[]}',
  )
  const store = createLocalStorageTrackerStore({ keyPrefix: 'p', storage })
  const record = await store.get(1, '0xbroken')
  expect(record).not.toBeNull()
  // firstSeenBlockNumber decoded as object (the malformed sentinel)
  // rather than throwing.
  expect(typeof record!.firstSeenBlockNumber).toBe('object')
})

test('listDurable skips when storage.key(i) returns null at an index', async () => {
  // Defensive: the DOM Storage spec says key(i) returns null for
  // out-of-bounds indices, but in-memory fakes (or polyfills) might
  // return null at valid indices if the underlying iteration is
  // sparse. The store's loop skips nulls rather than crashing.
  const storage = makeFakeStorage()
  // Seed via the real store so bigint fields get serialized correctly.
  const seedStore = createLocalStorageTrackerStore({ keyPrefix: 'p', storage })
  await seedStore.put(makeRecord({ hash: '0xa' }))
  const wrapped: LocalStorageLike = {
    get length() {
      return storage.length + 1
    },
    key: (i) => (i === 0 ? null : storage.key(i - 1)),
    getItem: (k) => storage.getItem(k),
    setItem: (k, v) => storage.setItem(k, v),
    removeItem: (k) => storage.removeItem(k),
  }
  const store = createLocalStorageTrackerStore({
    keyPrefix: 'p',
    storage: wrapped,
  })
  const result = await store.listDurable(1)
  expect(result.map((r) => r.hash)).toEqual(['0xa'])
})

test('listDurable skips records whose stored chainId disagrees with the queried chainId', async () => {
  // Defensive: even though the record key embeds chainId, an attacker-
  // or-corruption-injected record might disagree about its own chainId
  // field. The mismatch check excludes such records from the listing.
  const storage = makeFakeStorage()
  // Seed via a chainId-2 store so bigint fields get serialized correctly,
  // then move that key under the chainId-1 namespace to simulate the
  // mismatch. The body still carries chainId: 2.
  const seedStore = createLocalStorageTrackerStore({ keyPrefix: 'p', storage })
  await seedStore.put(makeRecord({ chainId: 2, hash: '0xmixed' }))
  // Move 'p:2:0xmixed' to 'p:1:0xmixed' — key namespace says chain 1,
  // body still says chain 2.
  const body = storage.getItem('p:2:0xmixed')!
  storage._set('p:1:0xmixed', body)
  storage.removeItem('p:2:0xmixed')
  const store = createLocalStorageTrackerStore({ keyPrefix: 'p', storage })
  const result = await store.listDurable(1)
  expect(result).toEqual([])
})

test('readEventLog returns [] when the key is absent', async () => {
  const storage = makeFakeStorage()
  const store = createLocalStorageTrackerStore({
    keyPrefix: 'p',
    storage,
  })
  const log = await store.readEventLog!(1, '0xunlogged')
  expect(log).toEqual([])
})

describe('integration with createTxTracker', () => {
  test('store roundtrips a durable record across tracker construction', async () => {
    // Smoke test: write a durable record via one store instance, then
    // a fresh tracker reading the same backing storage should see it
    // via listDurable. Pins the cross-process restart story.
    const storage = makeFakeStorage()
    const store: TxTrackerStore = createLocalStorageTrackerStore({
      keyPrefix: 'p',
      storage,
    })
    await store.put(makeRecord())
    const fresh: TxTrackerStore = createLocalStorageTrackerStore({
      keyPrefix: 'p',
      storage,
    })
    const records = await fresh.listDurable(1)
    expect(records).toHaveLength(1)
    expect(records[0].hash).toBe('0xabc')
  })

  test('appendEvent failure does not corrupt the record', async () => {
    // A Storage.setItem throw (quota exceeded, browser disabled
    // storage, etc.) should propagate from appendEvent so the
    // tracker's onError can route it — but should NOT leave the
    // record itself in a bad state.
    const storage = makeFakeStorage()
    const originalSetItem = storage.setItem
    const setItemSpy = vi.fn(originalSetItem)
    storage.setItem = setItemSpy
    const store = createLocalStorageTrackerStore({
      keyPrefix: 'p',
      storage,
    })
    await store.put(makeRecord())
    // Fail the next setItem (the eventlog write).
    setItemSpy.mockImplementationOnce(() => {
      throw new Error('quota exceeded')
    })
    await expect(
      store.appendEvent(
        1,
        '0xabc',
        buildSeenInBlock({
          hash: '0xabc',
          chainId: 1,
          source: 'block-poll',
          at: { blockNumber: 1n, timestamp: 0n },
          blockHash: '0xb',
          blockNumber: 1n,
          transactionIndex: 0,
          confirmations: 1,
        }),
      ),
    ).rejects.toThrow(/quota/)
    // Record itself still intact.
    const record = await store.get(1, '0xabc')
    expect(record).not.toBeNull()
  })
})
