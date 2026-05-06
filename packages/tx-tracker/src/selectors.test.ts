/**
 * Unit tests for `selectors.ts` — bulk matcher behavior. Pins:
 *
 *   - `from` / `to` lowercase the consumer-provided address once at
 *     compile time and compare lowercase-vs-lowercase, so a
 *     checksum-cased target finds a lowercased mempool tx.
 *   - `predicate` runs the caller's function as-is.
 *   - Malformed selectors throw at compile time, not silently zero
 *     match at run time.
 *   - `matchAll` skips txs without a `hash` (can't bulk-track them).
 */
import { test, expect } from 'vitest'

import type { RawTx } from '@valve-tech/chain-source'

import {
  compileSelector,
  defaultMaxBulkSubscriptions,
  matchAll,
} from './selectors.js'
import type { BulkSelector } from './store.js'

const tx = (overrides: Partial<RawTx> & Record<string, unknown>): RawTx =>
  ({
    hash: '0xabc',
    from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    nonce: '0x1',
    ...overrides,
  }) as RawTx

test('from selector compares lowercase-vs-lowercase', () => {
  const compiled = compileSelector({
    kind: 'from',
    address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // checksum-style
  })
  expect(
    compiled.match(tx({ from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })),
  ).toBe(true)
  expect(
    compiled.match(tx({ from: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })),
  ).toBe(false)
})

test('from selector is false on a tx with no from field', () => {
  const compiled = compileSelector({ kind: 'from', address: '0xa' })
  expect(compiled.match(tx({ from: undefined }))).toBe(false)
})

test('to selector reads tx.to off loosely-typed RawTx and lowercases', () => {
  const compiled = compileSelector({
    kind: 'to',
    address: '0xCONTRACT',
  })
  expect(compiled.match(tx({ to: '0xcontract' }))).toBe(true)
  expect(compiled.match(tx({ to: '0xother' }))).toBe(false)
})

test('to selector is false on a tx with no to field', () => {
  const compiled = compileSelector({ kind: 'to', address: '0xc' })
  expect(compiled.match(tx({ to: undefined }))).toBe(false)
})

test('predicate selector runs the caller fn unchanged', () => {
  const calls: RawTx[] = []
  const compiled = compileSelector({
    kind: 'predicate',
    match: (t) => {
      calls.push(t)
      return t.nonce === '0x42'
    },
  })
  const txA = tx({ nonce: '0x42' })
  const txB = tx({ nonce: '0x1' })
  expect(compiled.match(txA)).toBe(true)
  expect(compiled.match(txB)).toBe(false)
  expect(calls).toEqual([txA, txB])
})

test('compileSelector throws on malformed from / to', () => {
  expect(() => compileSelector({ kind: 'from' } as BulkSelector)).toThrow(
    /requires an address/,
  )
  expect(() => compileSelector({ kind: 'to' } as BulkSelector)).toThrow(
    /requires an address/,
  )
})

test('compileSelector throws on predicate without a match function', () => {
  expect(() =>
    compileSelector({ kind: 'predicate' } as BulkSelector),
  ).toThrow(/requires a match function/)
})

test('matchAll yields one payload per (tx, selector) match', () => {
  const fromSel = compileSelector({ kind: 'from', address: '0xa' })
  const predSel = compileSelector({
    kind: 'predicate',
    match: (t) => t.nonce === '0x1',
  })
  const txs: RawTx[] = [
    tx({ hash: '0xt1', from: '0xa', nonce: '0x1' }),
    tx({ hash: '0xt2', from: '0xb', nonce: '0x1' }),
    tx({ hash: '0xt3', from: '0xa', nonce: '0x2' }),
  ]
  const matches = matchAll(txs, [fromSel, predSel])

  // t1: from + predicate → 2 matches
  // t2: predicate only → 1
  // t3: from only → 1
  expect(matches).toHaveLength(4)
  expect(matches.map((m) => m.hash + ':' + m.matchedBy).sort()).toEqual([
    '0xt1:from',
    '0xt1:predicate',
    '0xt2:predicate',
    '0xt3:from',
  ])
})

test('matchAll skips txs without a hash (can\'t bulk-track them)', () => {
  const fromSel = compileSelector({ kind: 'from', address: '0xa' })
  const txs: RawTx[] = [
    tx({ hash: undefined, from: '0xa' }),
    tx({ hash: '0xt1', from: '0xa' }),
  ]
  const matches = matchAll(txs, [fromSel])
  expect(matches.map((m) => m.hash)).toEqual(['0xt1'])
})

test('defaultMaxBulkSubscriptions matches spec default (16)', () => {
  expect(defaultMaxBulkSubscriptions).toBe(16)
})
