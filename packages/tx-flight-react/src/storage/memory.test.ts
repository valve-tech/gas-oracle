import { test, expect } from 'vitest'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { memoryAdapter } from './memory.js'

const sample = (id: string): TrackedTx => ({
  id,
  chainId: 1,
  flow: 'send',
  submittedAt: 1,
  submittedTier: 'standard',
  status: 'pending',
})

test('memoryAdapter returns null for unset keys', async () => {
  const adapter = memoryAdapter()
  expect(await adapter.load('default')).toBeNull()
})

test('memoryAdapter round-trips a stored value', async () => {
  const adapter = memoryAdapter()
  const txs = [sample('tx-1'), sample('tx-2')]
  await adapter.save('default', txs)
  const loaded = await adapter.load('default')
  expect(loaded).toEqual(txs)
})

test('memoryAdapter scopes by id', async () => {
  const adapter = memoryAdapter()
  await adapter.save('a', [sample('tx-1')])
  await adapter.save('b', [sample('tx-2')])
  expect(await adapter.load('a')).toEqual([sample('tx-1')])
  expect(await adapter.load('b')).toEqual([sample('tx-2')])
})

test('memoryAdapter returns a defensive copy on load', async () => {
  const adapter = memoryAdapter()
  const stored = [sample('tx-1')]
  await adapter.save('default', stored)
  const loaded = await adapter.load('default')
  expect(loaded).not.toBe(stored)
})

test('memoryAdapter takes a defensive copy on save', async () => {
  const adapter = memoryAdapter()
  const original = [sample('tx-1')]
  await adapter.save('default', original)
  original.push(sample('tx-2'))   // mutate after save
  const loaded = await adapter.load('default')
  expect(loaded).toHaveLength(1)
})

test('separate memoryAdapter instances are independent', async () => {
  const a = memoryAdapter()
  const b = memoryAdapter()
  await a.save('default', [sample('tx-1')])
  expect(await b.load('default')).toBeNull()
})
