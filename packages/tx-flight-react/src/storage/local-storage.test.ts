import { test, expect, beforeEach } from 'vitest'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { localStorageAdapter } from './local-storage.js'

const sample = (id: string): TrackedTx => ({
  id,
  chainId: 1,
  flow: 'send',
  submittedAt: 1,
  submittedTier: 'standard',
  status: 'pending',
})

beforeEach(() => {
  globalThis.window.localStorage.clear()
})

test('localStorageAdapter returns null when no record exists', async () => {
  const adapter = localStorageAdapter()
  expect(await adapter.load('default')).toBeNull()
})

test('localStorageAdapter round-trips a stored value', async () => {
  const adapter = localStorageAdapter()
  const txs = [sample('tx-1'), sample('tx-2')]
  await adapter.save('default', txs)
  expect(await adapter.load('default')).toEqual(txs)
})

test('localStorageAdapter scopes by id', async () => {
  const adapter = localStorageAdapter()
  await adapter.save('a', [sample('tx-1')])
  await adapter.save('b', [sample('tx-2')])
  expect(await adapter.load('a')).toEqual([sample('tx-1')])
  expect(await adapter.load('b')).toEqual([sample('tx-2')])
})

test('localStorageAdapter respects custom keyPrefix', async () => {
  const adapter = localStorageAdapter({ keyPrefix: 'custom' })
  await adapter.save('default', [sample('tx-1')])
  // Underlying key should be 'custom:default'.
  expect(globalThis.window.localStorage.getItem('custom:default')).not.toBeNull()
  expect(globalThis.window.localStorage.getItem('tx-flight:default')).toBeNull()
})

test('localStorageAdapter persists bigint fields under submittedGas as 0x-hex', async () => {
  const adapter = localStorageAdapter()
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
  expect(out?.[0]?.submittedGas?.maxPriorityFeePerGas).toBe(1_000_000_000n)
})
