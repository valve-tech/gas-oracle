import { describe, expect, it } from 'vitest'

import { tipForBlockPosition } from './block-position.js'
import type { TipSample } from './types.js'

// Hand-built distribution with known order. After sortByTipDesc:
//   index 0: { tip: 5000, gas: 100, hash: '0xtop',     address: '0xa', nonce: '0' }
//   index 1: { tip: 4000, gas: 200, hash: '0xsecond',  address: '0xb', nonce: '1' }
//   index 2: { tip: 3000, gas: 100, hash: '0xthird',   address: '0xc', nonce: '2' }
//   index 3: { tip: 2000, gas: 300, hash: '0xfourth',  address: '0xd', nonce: '3' }
//   index 4: { tip: 1000, gas: 100, hash: '0xfifth',   address: '0xe', nonce: '4' }
// Cumulative gas walking from top: 100, 300, 400, 700, 800
const samples: TipSample[] = [
  { tip: 1000n, gas: 100n, hash: '0xfifth', address: '0xe', nonce: '4' },
  { tip: 5000n, gas: 100n, hash: '0xtop', address: '0xa', nonce: '0' },
  { tip: 3000n, gas: 100n, hash: '0xthird', address: '0xc', nonce: '2' },
  { tip: 4000n, gas: 200n, hash: '0xsecond', address: '0xb', nonce: '1' },
  { tip: 2000n, gas: 300n, hash: '0xfourth', address: '0xd', nonce: '3' },
]

describe('tipForBlockPosition: empty distribution', () => {
  it('returns the empty result on an empty sample array', () => {
    const r = tipForBlockPosition([], { kind: 'rank', rank: 0n })
    expect(r.requiredTip).toBe(0n)
    expect(r.pivot).toBeNull()
    expect(r.rank).toBe(0n)
    expect(r.gasFromTop).toBe(0n)
  })
})

describe("tipForBlockPosition: kind='rank'", () => {
  it('lands at the very top (rank 0)', () => {
    const r = tipForBlockPosition(samples, { kind: 'rank', rank: 0n })
    expect(r.pivot?.hash).toBe('0xtop')
    expect(r.requiredTip).toBe(5001n) // outbid the top tx by 1 wei
    expect(r.rank).toBe(0n)
    expect(r.gasFromTop).toBe(0n)
  })

  it('lands at rank 2 (third in block)', () => {
    const r = tipForBlockPosition(samples, { kind: 'rank', rank: 2n })
    expect(r.pivot?.hash).toBe('0xthird')
    expect(r.requiredTip).toBe(3001n)
    expect(r.rank).toBe(2n)
    expect(r.gasFromTop).toBe(300n) // gas from samples[0..1] = 100 + 200
  })

  it('returns the below-everyone answer when rank exceeds distribution', () => {
    const r = tipForBlockPosition(samples, { kind: 'rank', rank: 99n })
    expect(r.pivot).toBeNull()
    expect(r.requiredTip).toBe(0n)
    expect(r.rank).toBe(BigInt(samples.length))
    expect(r.gasFromTop).toBe(800n) // sum of all gas
  })
})

describe("tipForBlockPosition: kind='percentile'", () => {
  it('top 0% = the very top of the block', () => {
    const r = tipForBlockPosition(samples, { kind: 'percentile', percentile: 0n })
    expect(r.pivot?.hash).toBe('0xtop')
    expect(r.rank).toBe(0n)
  })

  it('40% lands at rank 2 of 5 (5 * 40 / 100 = 2)', () => {
    const r = tipForBlockPosition(samples, { kind: 'percentile', percentile: 40n })
    expect(r.rank).toBe(2n)
    expect(r.pivot?.hash).toBe('0xthird')
  })

  it('100% clamps to the last index (the bottom of the block)', () => {
    const r = tipForBlockPosition(samples, { kind: 'percentile', percentile: 100n })
    expect(r.rank).toBe(4n)
    expect(r.pivot?.hash).toBe('0xfifth')
  })

  it('clamps negative percentile to top of block', () => {
    const r = tipForBlockPosition(samples, { kind: 'percentile', percentile: -10n })
    expect(r.rank).toBe(0n)
  })

  it('clamps above-100 percentile to the last index (bottom of block)', () => {
    // > 100n drives the upper-clamp arm of the bigint percentile ternary.
    const r = tipForBlockPosition(samples, { kind: 'percentile', percentile: 150n })
    expect(r.rank).toBe(4n)
    expect(r.pivot?.hash).toBe('0xfifth')
  })
})

describe("tipForBlockPosition: kind='gasFromTop'", () => {
  it('gas=0n lands at the very top (no gas consumed yet)', () => {
    const r = tipForBlockPosition(samples, { kind: 'gasFromTop', gas: 0n })
    expect(r.pivot?.hash).toBe('0xtop')
    expect(r.gasFromTop).toBe(0n)
  })

  it('gas=200n lands at the sample whose cumul-gas first crosses 200 (0xsecond, idx 1)', () => {
    // Cumulatives: 100, 300, 400, 700, 800. Target 200 → first cross at idx=1
    const r = tipForBlockPosition(samples, { kind: 'gasFromTop', gas: 200n })
    expect(r.pivot?.hash).toBe('0xsecond')
    expect(r.rank).toBe(1n)
    expect(r.gasFromTop).toBe(100n)
  })

  it('gas=400n lands at idx=3 (cumul 400 needs to be exceeded, not equaled)', () => {
    // Cumulatives: 100, 300, 400, 700, 800. Target 400 → first STRICTLY > at idx=3
    const r = tipForBlockPosition(samples, { kind: 'gasFromTop', gas: 400n })
    expect(r.pivot?.hash).toBe('0xfourth')
    expect(r.rank).toBe(3n)
  })

  it('gas exceeding total returns the below-everyone result', () => {
    const r = tipForBlockPosition(samples, { kind: 'gasFromTop', gas: 100_000n })
    expect(r.pivot).toBeNull()
    expect(r.requiredTip).toBe(0n)
  })
})

describe("tipForBlockPosition: kind='aheadOf' / 'behind' (relative targeting)", () => {
  it("aheadOf by hash returns pivot.tip + 1", () => {
    const r = tipForBlockPosition(samples, {
      kind: 'aheadOf',
      tx: { hash: '0xthird' },
    })
    expect(r.pivot?.hash).toBe('0xthird')
    expect(r.requiredTip).toBe(3001n)
    expect(r.rank).toBe(2n)
  })

  it("aheadOf by address+nonce returns pivot.tip + 1", () => {
    const r = tipForBlockPosition(samples, {
      kind: 'aheadOf',
      tx: { address: '0xc', nonce: 2 },
    })
    expect(r.pivot?.hash).toBe('0xthird')
    expect(r.requiredTip).toBe(3001n)
  })

  it("behind by hash returns pivot.tip - 1 (just under the targeted tx)", () => {
    const r = tipForBlockPosition(samples, {
      kind: 'behind',
      tx: { hash: '0xthird' },
    })
    expect(r.pivot?.hash).toBe('0xthird')
    expect(r.requiredTip).toBe(2999n)
  })

  it("behind by address+nonce returns pivot.tip - 1", () => {
    const r = tipForBlockPosition(samples, {
      kind: 'behind',
      tx: { address: '0xc', nonce: 2 },
    })
    expect(r.requiredTip).toBe(2999n)
  })

  it('hash matching is case-insensitive', () => {
    const r = tipForBlockPosition(samples, {
      kind: 'aheadOf',
      tx: { hash: '0xTHIRD' },
    })
    expect(r.pivot?.hash).toBe('0xthird')
  })

  it('address matching is case-insensitive', () => {
    const r = tipForBlockPosition(samples, {
      kind: 'aheadOf',
      tx: { address: '0xC', nonce: 2 },
    })
    expect(r.pivot?.hash).toBe('0xthird')
  })

  it('nonce matching accepts hex / decimal / bigint forms', () => {
    const dec = tipForBlockPosition(samples, {
      kind: 'aheadOf',
      tx: { address: '0xc', nonce: '2' },
    })
    const hex = tipForBlockPosition(samples, {
      kind: 'aheadOf',
      tx: { address: '0xc', nonce: '0x2' },
    })
    const big = tipForBlockPosition(samples, {
      kind: 'aheadOf',
      tx: { address: '0xc', nonce: 2n },
    })
    expect(dec.pivot?.hash).toBe('0xthird')
    expect(hex.pivot?.hash).toBe('0xthird')
    expect(big.pivot?.hash).toBe('0xthird')
  })

  it("returns the pivot-not-found result when the tx isn't in the distribution", () => {
    const r = tipForBlockPosition(samples, {
      kind: 'aheadOf',
      tx: { hash: '0xnothere' },
    })
    expect(r.pivot).toBeNull()
    expect(r.requiredTip).toBe(0n)
  })

  it("'behind' clamps requiredTip at 0n when pivot.tip is already 0", () => {
    const zeroSample: TipSample[] = [
      { tip: 0n, gas: 100n, hash: '0xfree' },
      { tip: 100n, gas: 100n, hash: '0xpaying' },
    ]
    const r = tipForBlockPosition(zeroSample, {
      kind: 'behind',
      tx: { hash: '0xfree' },
    })
    expect(r.requiredTip).toBe(0n)
  })

  it('matchesIdentifier returns false for address-id queries against samples with no address', () => {
    // Drives the `if (sample.address === undefined || sample.nonce
    // === undefined) return false` guard in matchesIdentifier. A
    // ring sample whose txs lacked from/nonce fields can't satisfy
    // an address-id query — resolves as "not found" rather than
    // throwing on the lowercase-comparison.
    const samples: TipSample[] = [
      { tip: 100n, gas: 100n, hash: '0xnoid' },
      { tip: 50n, gas: 100n, hash: '0xother' },
    ]
    const result = tipForBlockPosition(samples, {
      kind: 'aheadOf',
      tx: { address: '0xanyone', nonce: 0n },
    })
    expect(result.pivot).toBeNull()
  })
})
