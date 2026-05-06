/**
 * Unit tests for `store.ts` — `createInMemoryStore` retention,
 * eviction, log capacity, and durable-list filtering. Pins the
 * three guarantees consumers depend on per spec §9 + §10:
 *
 *   - `put` / `get` / `delete` are idempotent on `(chainId, hash)`.
 *   - `appendEvent` enforces the `eventLogCapacity` ring; older
 *     entries fall off the front when the cap is exceeded.
 *   - `listDurable` returns only records carrying at least one
 *     `durable: true` subscription, scoped to the requested chain.
 */
import { test, expect } from 'vitest'

import type { Capabilities } from '@valve-tech/chain-source'

import {
  buildInitialStatus,
  buildSeenInBlock,
  type TxStatus,
} from './events.js'
import {
  computeRetentionExpiry,
  createInMemoryStore,
  defaultRetentionBlocks,
  type TrackedTxRecord,
} from './store.js'

const CAPS: Capabilities = {
  newHeads: 'subscription',
  newPendingTransactions: 'poll-only',
  txpoolContent: 'available',
  receiptByHash: 'available',
  reprobeOnReconnect: true,
}

const makeStatus = (hash: string): TxStatus =>
  buildInitialStatus({ hash, chainId: 1, capabilities: CAPS })

const makeRecord = (
  hash: string,
  durable: boolean = false,
  chainId: number = 1,
): TrackedTxRecord => ({
  chainId,
  hash,
  status: makeStatus(hash),
  firstSeenBlockNumber: 100n,
  lastObservedBlockNumber: 100n,
  retentionExpiresAtBlockNumber: 164n,
  subscriptions: [
    { id: 'sub-1', durable, selector: { kind: 'hash', hash } },
  ],
})

test('put / get is idempotent on (chainId, hash)', async () => {
  const store = createInMemoryStore()
  const record = makeRecord('0xa')
  await store.put(record)
  await store.put(record)
  const read = await store.get(1, '0xa')
  expect(read).toBe(record)
})

test('get returns null for unknown hash', async () => {
  const store = createInMemoryStore()
  expect(await store.get(1, '0xunknown')).toBeNull()
})

test('delete removes the record AND its event log', async () => {
  const store = createInMemoryStore()
  const record = makeRecord('0xa')
  await store.put(record)
  await store.appendEvent(1, '0xa', buildEvent('0xa', 100n))
  await store.delete(1, '0xa')
  expect(await store.get(1, '0xa')).toBeNull()
  expect(await store.readEventLog!(1, '0xa')).toEqual([])
})

test('listDurable returns ONLY records with at least one durable sub', async () => {
  const store = createInMemoryStore()
  await store.put(makeRecord('0xa', true))
  await store.put(makeRecord('0xb', false))
  await store.put(makeRecord('0xc', true))
  const durable = await store.listDurable(1)
  expect(durable.map((r) => r.hash).sort()).toEqual(['0xa', '0xc'])
})

test('listDurable scopes to the requested chainId', async () => {
  const store = createInMemoryStore()
  await store.put(makeRecord('0xa', true, 1))
  await store.put(makeRecord('0xb', true, 137))
  expect((await store.listDurable(1)).map((r) => r.hash)).toEqual(['0xa'])
  expect((await store.listDurable(137)).map((r) => r.hash)).toEqual(['0xb'])
})

test('appendEvent / readEventLog round-trips entries in order', async () => {
  const store = createInMemoryStore()
  const e1 = buildEvent('0xa', 100n)
  const e2 = buildEvent('0xa', 101n)
  await store.appendEvent(1, '0xa', e1)
  await store.appendEvent(1, '0xa', e2)
  const log = await store.readEventLog!(1, '0xa')
  expect(log).toEqual([e1, e2])
})

test('readEventLog filters to entries with at.blockNumber >= since', async () => {
  const store = createInMemoryStore()
  await store.appendEvent(1, '0xa', buildEvent('0xa', 100n))
  await store.appendEvent(1, '0xa', buildEvent('0xa', 105n))
  await store.appendEvent(1, '0xa', buildEvent('0xa', 110n))
  const filtered = await store.readEventLog!(1, '0xa', 105n)
  expect(filtered.map((e) => e.at.blockNumber)).toEqual([105n, 110n])
})

test('eventLogCapacity enforces a bounded ring (oldest dropped first)', async () => {
  const store = createInMemoryStore({ eventLogCapacity: 3 })
  for (let i = 0; i < 5; i++) {
    await store.appendEvent(1, '0xa', buildEvent('0xa', BigInt(100 + i)))
  }
  const log = await store.readEventLog!(1, '0xa')
  expect(log.length).toBe(3)
  expect(log.map((e) => e.at.blockNumber)).toEqual([102n, 103n, 104n])
})

test('readEventLog returns a copy — caller mutations do not affect store', async () => {
  const store = createInMemoryStore()
  await store.appendEvent(1, '0xa', buildEvent('0xa', 100n))
  const log = await store.readEventLog!(1, '0xa')
  log.push(buildEvent('0xa', 999n))
  const second = await store.readEventLog!(1, '0xa')
  expect(second.length).toBe(1)
})

test('computeRetentionExpiry adds the configured window in block-units', () => {
  expect(computeRetentionExpiry(100n)).toBe(100n + BigInt(defaultRetentionBlocks))
  expect(computeRetentionExpiry(100n, 12)).toBe(112n)
  expect(computeRetentionExpiry(100n, 0)).toBe(100n)
})

test('readEventLog on an unknown hash returns an empty array', async () => {
  const store = createInMemoryStore()
  expect(await store.readEventLog!(1, '0xunknown')).toEqual([])
})

// ---------- helpers ----------

function buildEvent(hash: string, blockNumber: bigint) {
  return buildSeenInBlock({
    hash,
    chainId: 1,
    source: 'block-poll',
    at: { blockNumber, timestamp: blockNumber * 12n },
    blockHash: '0xb' + blockNumber.toString(),
    blockNumber,
    transactionIndex: 0,
    confirmations: 1,
  })
}
