import { test, expect } from 'vitest'

import { normalizeMempool } from './mempool.js'
import type { TxPoolContent } from './types.js'

test('normalizeMempool returns empty subpools when input is null', () => {
  const result = normalizeMempool(null)
  expect(result).toEqual({ pending: {}, queued: {} })
})

test('normalizeMempool returns empty subpools when input is undefined', () => {
  const result = normalizeMempool(undefined)
  expect(result).toEqual({ pending: {}, queued: {} })
})

test('normalizeMempool lowercases sender address keys', () => {
  const input: TxPoolContent = {
    pending: { '0xAbCdEf0123456789012345678901234567890000': { '5': { hash: '0x1' } } },
    queued: {},
  }
  const result = normalizeMempool(input)
  expect(result.pending).toHaveProperty(
    '0xabcdef0123456789012345678901234567890000',
  )
  expect(result.pending).not.toHaveProperty(
    '0xAbCdEf0123456789012345678901234567890000',
  )
})

test('normalizeMempool converts hex nonce keys to decimal', () => {
  const input: TxPoolContent = {
    pending: { '0xabc': { '0xa': { hash: '0xdef' } } },
    queued: {},
  }
  const result = normalizeMempool(input)
  expect(result.pending['0xabc']).toEqual({ '10': { hash: '0xdef' } })
})

test('normalizeMempool keeps decimal nonce keys as-is', () => {
  const input: TxPoolContent = {
    pending: { '0xabc': { '5': { hash: '0xdef' } } },
    queued: {},
  }
  const result = normalizeMempool(input)
  expect(result.pending['0xabc']).toEqual({ '5': { hash: '0xdef' } })
})

test('normalizeMempool normalizes both pending and queued subpools', () => {
  const input: TxPoolContent = {
    pending: { '0xAAA': { '0x1': { hash: '0x10' } } },
    queued: { '0xBBB': { '0x2': { hash: '0x20' } } },
  }
  const result = normalizeMempool(input)
  expect(result).toEqual({
    pending: { '0xaaa': { '1': { hash: '0x10' } } },
    queued: { '0xbbb': { '2': { hash: '0x20' } } },
  })
})

test('normalizeMempool is idempotent — re-normalizing produces an equivalent shape', () => {
  const input: TxPoolContent = {
    pending: { '0xABC': { '0x5': { hash: '0xdef' } } },
    queued: {},
  }
  const once = normalizeMempool(input)
  const twice = normalizeMempool(once)
  expect(twice).toEqual(once)
})

test('normalizeMempool treats missing pending/queued sub-objects as empty', () => {
  // Some upstream clients may return a partial response. Don't crash;
  // give the consumer the shape it expects (both keys present).
  const input = { pending: undefined, queued: undefined } as unknown as TxPoolContent
  const result = normalizeMempool(input)
  expect(result).toEqual({ pending: {}, queued: {} })
})

test('normalizeMempool preserves the inner RawTx unchanged', () => {
  // Pool normalization is for the OUTER keys only — the inner tx
  // fields (hash, from, nonce strings, fee fields) are passed through
  // by reference. Downstream lookup helpers that compare on tx.hash
  // do their own case-folding.
  const tx = { hash: '0xMixedCaseHashHere', from: '0xMiXeD', nonce: '0x5' }
  const input: TxPoolContent = {
    pending: { '0xABC': { '0x5': tx } },
    queued: {},
  }
  const result = normalizeMempool(input)
  expect(result.pending['0xabc']!['5']).toBe(tx)
})
