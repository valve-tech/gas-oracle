/**
 * Unit tests for `reorg.ts` — pure detector behavior over hand-built
 * block sequences. Exercises:
 *
 *   - clean chain extension produces no divergences
 *   - same-height-different-hash produces a divergence carrying both
 *     hashes + the affected tx-hash set
 *   - the depth window bounds how far back the comparison runs
 *   - `appendBlock` evicts the oldest entry when the ring overflows
 *     and replaces a same-height entry instead of duplicating it
 */
import { test, expect } from 'vitest'

import {
  appendBlock,
  defaultReorgDepthBlocks,
  detectDivergences,
  type BlockSample,
} from './reorg.js'

const sample = (
  number: bigint,
  hash: string,
  parentHash: string | null,
  txs: string[] = [],
): BlockSample => ({
  number,
  hash,
  parentHash,
  transactionHashes: new Set(txs),
})

test('detectDivergences returns [] for a clean chain extension', () => {
  const ring = [
    sample(100n, '0xa', '0xprev'),
    sample(101n, '0xb', '0xa'),
  ]
  const canonical = [...ring, sample(102n, '0xc', '0xb')]
  expect(
    detectDivergences({ ring, canonical, depthBlocks: 12 }),
  ).toEqual([])
})

test('detectDivergences flags a same-height different-hash reorg', () => {
  const ring = [
    sample(100n, '0xa', '0xprev', ['0xtx1']),
    sample(101n, '0xb', '0xa'),
  ]
  const canonical = [
    sample(100n, '0xa-prime', '0xprev', ['0xtx99']),
    sample(101n, '0xb', '0xa'),
  ]
  const divergences = detectDivergences({ ring, canonical, depthBlocks: 12 })
  expect(divergences).toHaveLength(1)
  expect(divergences[0]).toMatchObject({
    blockNumber: 100n,
    previousBlockHash: '0xa',
    canonicalBlockHash: '0xa-prime',
  })
  expect([...divergences[0].vanishedTransactionHashes]).toEqual(['0xtx1'])
})

test('detectDivergences skips heights with no canonical entry (partial canonical)', () => {
  // Heights present in `ring` but missing from `canonical` are NOT
  // flagged as divergences — the detector treats missing canonical
  // as "no information" rather than "vanished" so a tracker passing
  // a single-block canonical doesn't accidentally nuke ring entries
  // at unrelated heights. A real "tx vanished from canonical chain"
  // detection requires the caller to explicitly pass the canonical
  // block at that height.
  const ring = [
    sample(100n, '0xa', '0xprev'),
    sample(101n, '0xb', '0xa', ['0xtx1']),
  ]
  const canonical = [sample(100n, '0xa', '0xprev')]
  expect(
    detectDivergences({ ring, canonical, depthBlocks: 12 }),
  ).toEqual([])
})

test('detectDivergences emits divergences in ascending block-number order', () => {
  const ring = [
    sample(100n, '0xa', '0xprev'),
    sample(101n, '0xb', '0xa'),
    sample(102n, '0xc', '0xb'),
  ]
  const canonical = [
    sample(100n, '0xa-prime', '0xprev'),
    sample(101n, '0xb-prime', '0xa-prime'),
    sample(102n, '0xc', '0xb'),
  ]
  const divergences = detectDivergences({ ring, canonical, depthBlocks: 12 })
  expect(divergences.map((d) => d.blockNumber)).toEqual([100n, 101n])
})

test('depthBlocks bounds the comparison window', () => {
  const ring = [
    sample(90n, '0xold', '0x89', ['0xtxold']),
    sample(99n, '0xnine', '0x98'),
    sample(100n, '0xa', '0xnine'),
  ]
  const canonical = [
    // 90 changed, but well outside depth=2 window from tip=100
    sample(90n, '0xold-prime', '0x89'),
    sample(99n, '0xnine', '0x98'),
    sample(100n, '0xa', '0xnine'),
  ]
  const divergences = detectDivergences({ ring, canonical, depthBlocks: 2 })
  expect(divergences).toEqual([])
})

test('detectDivergences returns [] when either side is empty', () => {
  const ring = [sample(100n, '0xa', '0xprev')]
  expect(
    detectDivergences({ ring: [], canonical: ring, depthBlocks: 12 }),
  ).toEqual([])
  expect(
    detectDivergences({ ring, canonical: [], depthBlocks: 12 }),
  ).toEqual([])
})

test('appendBlock keeps ascending order and respects capacity', () => {
  let ring: BlockSample[] = []
  for (let i = 0; i < 5; i++) {
    ring = appendBlock(ring, sample(BigInt(100 + i), '0xh' + i, null), 3)
  }
  expect(ring.map((b) => b.number)).toEqual([102n, 103n, 104n])
})

test('appendBlock REPLACES a same-height entry rather than duplicating', () => {
  let ring: BlockSample[] = []
  ring = appendBlock(ring, sample(100n, '0xstale', null), 12)
  ring = appendBlock(ring, sample(100n, '0xfresh', null), 12)
  expect(ring).toHaveLength(1)
  expect(ring[0].hash).toBe('0xfresh')
})

test('appendBlock does not mutate its input array', () => {
  const original: BlockSample[] = [sample(100n, '0xa', null)]
  const next = appendBlock(original, sample(101n, '0xb', '0xa'), 12)
  expect(original).toHaveLength(1)
  expect(next).toHaveLength(2)
})

test('defaultReorgDepthBlocks matches the spec default (12)', () => {
  expect(defaultReorgDepthBlocks).toBe(12)
})
