import { test, expect } from 'vitest'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { serialize, deserialize } from './serialize.js'

const sample = (overrides: Partial<TrackedTx> = {}): TrackedTx => ({
  id: 'tx-1',
  chainId: 1,
  flow: 'send',
  submittedAt: 1_000_000,
  submittedTier: 'standard',
  status: 'pending',
  ...overrides,
})

test('round-trips a TrackedTx without bigint fields', () => {
  const original = [sample()]
  const out = deserialize(serialize(original))
  expect(out).toEqual(original)
})

test('round-trips bigint fields under submittedGas as 0x-hex strings', () => {
  const original = [
    sample({
      submittedGas: {
        maxFeePerGas: 1234567890123456789n,
        maxPriorityFeePerGas: 987n,
      },
    }),
  ]
  const out = deserialize(serialize(original))
  expect(out[0]?.submittedGas?.maxFeePerGas).toBe(1234567890123456789n)
  expect(out[0]?.submittedGas?.maxPriorityFeePerGas).toBe(987n)
})

test('preserves all optional fields across the round trip', () => {
  const original = [
    sample({
      hash: '0xabc',
      confirmedAt: 2_000_000,
      replacedBy: '0xnewhash',
      replaces: '0xoldhash',
      notes: 'cancelled in wallet',
      status: 'failed',
    }),
  ]
  const out = deserialize(serialize(original))
  expect(out).toEqual(original)
})

test('serializes an empty array round-trip', () => {
  expect(deserialize(serialize([]))).toEqual([])
})
