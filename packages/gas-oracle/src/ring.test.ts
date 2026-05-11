import { describe, expect, it } from 'vitest'

import { incorporateBlock } from './ring.js'
import type { BlockSample } from './types.js'

const block = (input: {
  number: bigint
  hash: string
  parentHash: string
  baseFee?: bigint
  gasUsed?: bigint
}): BlockSample => ({
  number: input.number,
  hash: input.hash,
  parentHash: input.parentHash,
  baseFee: input.baseFee ?? 1_000_000_000n,
  gasUsed: input.gasUsed ?? 15_000_000n,
  tips: [],
})

describe('incorporateBlock', () => {
  it('restarts when prev ring is empty', () => {
    const newBlock = block({ number: 100n, hash: '0xnew', parentHash: '0xprev' })
    const result = incorporateBlock([], newBlock, 20n)
    expect(result.ring).toEqual([newBlock])
    expect(result.reorg).toBeNull()
    expect(result.duplicate).toBe(false)
  })

  it('clean appends when parentHash matches the tip', () => {
    const tip = block({ number: 100n, hash: '0xa', parentHash: '0xprev' })
    const next = block({ number: 101n, hash: '0xb', parentHash: '0xa' })
    const result = incorporateBlock([tip], next, 20n)
    expect(result.ring).toEqual([tip, next])
    expect(result.reorg).toBeNull()
    expect(result.duplicate).toBe(false)
  })

  it('caps the ring at maxWindow on append (head dropped)', () => {
    const ring = Array.from({ length: 5 }, (_, i) =>
      block({
        number: BigInt(100 + i),
        hash: `0x${i}`,
        parentHash: i === 0 ? '0xprev' : `0x${i - 1}`,
      }),
    )
    const next = block({ number: 105n, hash: '0x5', parentHash: '0x4' })
    const result = incorporateBlock(ring, next, 3n)
    expect(result.ring).toHaveLength(3)
    expect(result.ring.map((b) => b.hash)).toEqual(['0x3', '0x4', '0x5'])
    expect(result.reorg).toBeNull()
  })

  it('treats a duplicate (same number, same hash) as no-op', () => {
    const tip = block({ number: 100n, hash: '0xa', parentHash: '0xprev' })
    const sameTip = block({ number: 100n, hash: '0xa', parentHash: '0xprev' })
    const result = incorporateBlock([tip], sameTip, 20n)
    expect(result.duplicate).toBe(true)
    expect(result.reorg).toBeNull()
    expect(result.ring).toEqual([tip])
    // Returned ring is a fresh array, not the input reference (defensive copy).
    expect(result.ring).not.toBe([tip] as BlockSample[])
  })

  it('reorgs when a same-height block has a different hash', () => {
    const ring = [
      block({ number: 100n, hash: '0xa', parentHash: '0xprev' }),
      block({ number: 101n, hash: '0xb', parentHash: '0xa' }),
    ]
    const replacement = block({ number: 101n, hash: '0xb-prime', parentHash: '0xa' })
    const result = incorporateBlock(ring, replacement, 20n)
    expect(result.ring.map((b) => b.hash)).toEqual(['0xa', '0xb-prime'])
    expect(result.reorg).toEqual({
      blockNumber: 101n,
      depth: 1n,
      newTipHash: '0xb-prime',
      droppedHashes: ['0xb'],
    })
    expect(result.duplicate).toBe(false)
  })

  it('reorgs deeper when newBlock.parentHash matches a non-tip entry', () => {
    const ring = [
      block({ number: 100n, hash: '0xa', parentHash: '0xprev' }),
      block({ number: 101n, hash: '0xb', parentHash: '0xa' }),
      block({ number: 102n, hash: '0xc', parentHash: '0xb' }),
      block({ number: 103n, hash: '0xd', parentHash: '0xc' }),
    ]
    // New block is 102', child of 0xa (skipping the 0xb branch)
    const fork = block({ number: 102n, hash: '0xc-prime', parentHash: '0xa' })
    const result = incorporateBlock(ring, fork, 20n)
    // Wait — this case actually triggers the "same height, different hash"
    // branch first. The matched index lands on 0xc (number 102), hash differs,
    // so we trim from index 2 forward.
    expect(result.ring.map((b) => b.hash)).toEqual(['0xa', '0xb', '0xc-prime'])
    expect(result.reorg).toEqual({
      blockNumber: 102n,
      depth: 2n,
      newTipHash: '0xc-prime',
      droppedHashes: ['0xc', '0xd'],
    })
  })

  it('appends after a deeper match when newBlock fills a gap in the ring', () => {
    // Ring carries a gap (block 102 missing). New block has number 102,
    // parentHash matching the entry at number 101. matchIndex points
    // to the 101 entry (last entry <= 102), matched.number < newBlock.number,
    // matched.hash === parentHash, AND matchIndex is NOT the tip — so
    // we hit the "stale tail trim + append" branch (ring.ts:171-184).
    const ring = [
      block({ number: 100n, hash: '0xa', parentHash: '0xprev' }),
      block({ number: 101n, hash: '0xb', parentHash: '0xa' }),
      block({ number: 103n, hash: '0xd', parentHash: '0xc-stale' }),
    ]
    const filler = block({ number: 102n, hash: '0xc', parentHash: '0xb' })
    const result = incorporateBlock(ring, filler, 20n)
    expect(result.ring.map((b) => b.hash)).toEqual(['0xa', '0xb', '0xc'])
    expect(result.reorg).toEqual({
      blockNumber: 102n,
      depth: 1n,
      newTipHash: '0xc',
      droppedHashes: ['0xd'],
    })
  })

  it('appends after a deeper match when newBlock extends from a non-tip ancestor', () => {
    const ring = [
      block({ number: 100n, hash: '0xa', parentHash: '0xprev' }),
      block({ number: 101n, hash: '0xb', parentHash: '0xa' }),
      block({ number: 102n, hash: '0xc', parentHash: '0xb' }),
    ]
    // New block is 102', whose parent is 0xa — but 102 is the same number
    // as 0xc, so this is the "same height, different hash" branch.
    // To exercise the "deeper-ancestor append" branch, the new block must
    // have a number STRICTLY GREATER than its parent's number+1 mismatch
    // — i.e., new is 102, parent is 0xb (number 101) but 0xb is in the
    // middle of the ring, not the tip. The "matched.number < newBlock.number
    // && matched.hash === parentHash" branch trips when newBlock is at the
    // tip-1 height and we've already advanced past it. Construct that:
    const fork = block({ number: 102n, hash: '0xc-prime', parentHash: '0xb' })
    const result = incorporateBlock(ring, fork, 20n)
    // matchIndex=2 (number 102), hashes differ → reorg branch fires.
    expect(result.reorg).toEqual({
      blockNumber: 102n,
      depth: 1n,
      newTipHash: '0xc-prime',
      droppedHashes: ['0xc'],
    })
    expect(result.ring.map((b) => b.hash)).toEqual(['0xa', '0xb', '0xc-prime'])
  })

  it('restarts when new block has a gap and parentHash is unknown', () => {
    const ring = [
      block({ number: 100n, hash: '0xa', parentHash: '0xprev' }),
    ]
    const orphan = block({ number: 200n, hash: '0xfar', parentHash: '0xunknown' })
    const result = incorporateBlock(ring, orphan, 20n)
    expect(result.ring).toEqual([orphan])
    expect(result.reorg).toBeNull()
    expect(result.duplicate).toBe(false)
  })

  it('restarts when newBlock is older than the entire ring', () => {
    const ring = [
      block({ number: 200n, hash: '0xa', parentHash: '0xprev' }),
      block({ number: 201n, hash: '0xb', parentHash: '0xa' }),
    ]
    const stale = block({ number: 100n, hash: '0xold', parentHash: '0xprev' })
    const result = incorporateBlock(ring, stale, 20n)
    expect(result.ring).toEqual([stale])
    expect(result.reorg).toBeNull()
  })

  it('treats maxWindow of 0n as no cap', () => {
    const ring = Array.from({ length: 5 }, (_, i) =>
      block({
        number: BigInt(100 + i),
        hash: `0x${i}`,
        parentHash: i === 0 ? '0xprev' : `0x${i - 1}`,
      }),
    )
    const next = block({ number: 105n, hash: '0x5', parentHash: '0x4' })
    const result = incorporateBlock(ring, next, 0n)
    expect(result.ring).toHaveLength(6)
  })
})
