import { describe, it, expect } from 'vitest'

import {
  cappedTip,
  computeBlobBaseFee,
  computePercentiles,
  computeTiers,
  detectTrend,
  effectiveTip,
  flattenTxPool,
  gasWeightedPercentiles,
  sortedTips,
} from './math.js'
import { blockToSample } from './samples.js'
import type { BlockResult } from './transport.js'
import {
  PriorityModel,
  Trend,
  type RawTx,
  type TipSample,
} from './types.js'

/* -------------------------------------------------------------------------- */
/*  effectiveTip                                                              */
/* -------------------------------------------------------------------------- */

describe('effectiveTip', () => {
  const baseFee = 1000n

  it('computes EIP-1559 tip as min(maxPriority, maxFee - baseFee)', () => {
    // maxPriority=100 < headroom=1000 → tip=100
    const tx: RawTx = { maxPriorityFeePerGas: '0x64', maxFeePerGas: '0x7d0', type: '0x2' }
    expect(effectiveTip(tx, baseFee)).toBe(100n)
  })

  it('caps tip when headroom is the binding constraint', () => {
    // maxPriority=1000, headroom=400 → tip=400
    const tx: RawTx = { maxPriorityFeePerGas: '0x3e8', maxFeePerGas: '0x578', type: '0x2' }
    expect(effectiveTip(tx, baseFee)).toBe(400n)
  })

  it('returns 0 when maxFeePerGas <= baseFee (no headroom)', () => {
    const tx: RawTx = { maxPriorityFeePerGas: '0x64', maxFeePerGas: '0x1f4', type: '0x2' }
    expect(effectiveTip(tx, baseFee)).toBe(0n)
  })

  it('handles legacy txs via gasPrice - baseFee', () => {
    const tx: RawTx = { gasPrice: '0x5dc', type: '0x0' }
    expect(effectiveTip(tx, baseFee)).toBe(500n)
  })

  it('clamps legacy tip at zero when gasPrice <= baseFee', () => {
    const tx: RawTx = { gasPrice: '0x1f4', type: '0x0' }
    expect(effectiveTip(tx, baseFee)).toBe(0n)
  })

  it('returns 0 when no fee fields are present', () => {
    expect(effectiveTip({}, baseFee)).toBe(0n)
  })
})

/* -------------------------------------------------------------------------- */
/*  computePercentiles                                                        */
/* -------------------------------------------------------------------------- */

describe('computePercentiles', () => {
  it('returns the right percentile from a sorted ascending array', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => BigInt(i))
    const p = computePercentiles(sorted)
    expect(p.p10).toBe(10n)
    expect(p.p25).toBe(25n)
    expect(p.p50).toBe(50n)
    expect(p.p75).toBe(75n)
    expect(p.p90).toBe(90n)
  })

  it('returns all zeros for an empty input', () => {
    expect(computePercentiles([])).toEqual({ p10: 0n, p25: 0n, p50: 0n, p75: 0n, p90: 0n })
  })

  it('handles a single-element array (every bucket is the same value)', () => {
    expect(computePercentiles([42n])).toEqual({ p10: 42n, p25: 42n, p50: 42n, p75: 42n, p90: 42n })
  })
})

/* -------------------------------------------------------------------------- */
/*  sortedTips                                                                */
/* -------------------------------------------------------------------------- */

describe('sortedTips', () => {
  it('runs effectiveTip on each tx and returns a sorted bigint array', () => {
    const baseFee = 1_000_000_000n
    const txs: RawTx[] = [
      { maxPriorityFeePerGas: '0x3e8', maxFeePerGas: '0x77359400', type: '0x2' }, // tip=1000
      { maxPriorityFeePerGas: '0x64',  maxFeePerGas: '0x77359400', type: '0x2' }, // tip=100
      { maxPriorityFeePerGas: '0x1f4', maxFeePerGas: '0x77359400', type: '0x2' }, // tip=500
    ]
    expect(sortedTips(txs, baseFee)).toEqual([100n, 500n, 1000n])
  })

  it('returns an empty array for no txs', () => {
    expect(sortedTips([], 1n)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/*  detectTrend                                                               */
/* -------------------------------------------------------------------------- */

describe('detectTrend', () => {
  it('flags rising when last/first delta is > 10%', () => {
    expect(detectTrend([100n, 105n, 110n, 115n, 120n])).toBe(Trend.rising)
  })

  it('flags falling when last/first delta is < -10%', () => {
    expect(detectTrend([100n, 95n, 90n, 85n, 80n])).toBe(Trend.falling)
  })

  it('returns stable when within ±10%', () => {
    expect(detectTrend([100n, 101n, 102n, 103n, 105n])).toBe(Trend.stable)
  })

  it('returns stable for a single entry', () => {
    expect(detectTrend([42n])).toBe(Trend.stable)
  })

  it('returns stable for an empty array', () => {
    expect(detectTrend([])).toBe(Trend.stable)
  })

  it('returns rising when first is 0 and last is positive', () => {
    expect(detectTrend([0n, 100n])).toBe(Trend.rising)
  })

  it('returns stable when first and last are both 0', () => {
    expect(detectTrend([0n, 0n])).toBe(Trend.stable)
  })
})

/* -------------------------------------------------------------------------- */
/*  cappedTip                                                                 */
/* -------------------------------------------------------------------------- */

describe('cappedTip', () => {
  it('returns the raw tip when no anchor is provided (cold start)', () => {
    expect(cappedTip(500n, 100n, undefined, undefined)).toBe(500n)
    expect(cappedTip(500n, 100n, 10000n, undefined)).toBe(500n)
    expect(cappedTip(500n, 100n, undefined, 99n)).toBe(500n)
  })

  it('clamps the downside at last * 7/8 after one block', () => {
    expect(cappedTip(500n, 100n, 5000n, 99n)).toBe(4375n)
  })

  it('clamps the downside at last * (7/8)^5 after five blocks', () => {
    // 5000 * 7^5 / 8^5 = 5000 * 16807 / 32768 = 2564 (integer division)
    expect(cappedTip(0n, 104n, 5000n, 99n)).toBe(2564n)
  })

  it('lets the raw tip pass through when it exceeds the floor', () => {
    expect(cappedTip(50000n, 100n, 1000n, 99n)).toBe(50000n)
  })

  it('holds the line on same-block duplicate polls (nBlocks = 0)', () => {
    expect(cappedTip(100n, 99n, 5000n, 99n)).toBe(5000n)
    expect(cappedTip(9000n, 99n, 5000n, 99n)).toBe(9000n)
  })

  it('holds the line on negative nBlocks (clock-skewed upstreams)', () => {
    expect(cappedTip(100n, 95n, 5000n, 99n)).toBe(5000n)
  })

  it('decays the floor toward zero after many blocks', () => {
    // After 20 blocks: 5000 * (7/8)^20 ≈ 346
    const result = cappedTip(0n, 119n, 5000n, 99n)
    expect(result).toBeGreaterThan(300n)
    expect(result).toBeLessThan(400n)
  })

  it('respects an explicit decay cap of 12.5% (matches default)', () => {
    const WAD = 1_000_000_000_000_000_000n
    expect(cappedTip(500n, 100n, 5000n, 99n, WAD / 8n)).toBe(4375n)
  })

  it('returns the raw tip when decayCap is null (uncapped)', () => {
    expect(cappedTip(1n, 100n, 5000n, 99n, null)).toBe(1n)
    expect(cappedTip(50000n, 100n, 5000n, 99n, null)).toBe(50000n)
  })

  it('holds the floor at lastPublished when decayCap is 0 (no decay allowed)', () => {
    // 0 decay → retention = 1.0, floor stays at 5000 forever
    expect(cappedTip(100n, 100n, 5000n, 99n, 0n)).toBe(5000n)
    expect(cappedTip(100n, 200n, 5000n, 99n, 0n)).toBe(5000n)
  })

  it('collapses to zero after one block when decayCap is WAD (100%)', () => {
    const WAD = 1_000_000_000_000_000_000n
    // 100% decay → retention = 0, floor = 0 after first block elapsed
    expect(cappedTip(10n, 100n, 5000n, 99n, WAD)).toBe(10n)
    expect(cappedTip(0n, 100n, 5000n, 99n, WAD)).toBe(0n)
  })

  it('decays at 50%/block when decayCap is WAD/2', () => {
    const WAD = 1_000_000_000_000_000_000n
    // 50% decay → retention = 0.5; after 3 blocks: 1000 * 0.5^3 = 125
    expect(cappedTip(0n, 102n, 1000n, 99n, WAD / 2n)).toBe(125n)
  })
})

/* -------------------------------------------------------------------------- */
/*  gasWeightedPercentiles                                                    */
/* -------------------------------------------------------------------------- */

describe('gasWeightedPercentiles', () => {
  it('returns 0n for every percentile on an empty sample set', () => {
    const out = gasWeightedPercentiles([], [10, 50, 75, 90])
    expect(out[10]).toBe(0n)
    expect(out[50]).toBe(0n)
    expect(out[75]).toBe(0n)
    expect(out[90]).toBe(0n)
  })

  it('returns the same tip at every percentile for a single sample', () => {
    const out = gasWeightedPercentiles([{ tip: 1234n, gas: 21000n }], [10, 50, 75, 90])
    expect(out[10]).toBe(1234n)
    expect(out[50]).toBe(1234n)
    expect(out[75]).toBe(1234n)
    expect(out[90]).toBe(1234n)
  })

  it('returns 0n at every percentile when totalGas is zero', () => {
    const out = gasWeightedPercentiles(
      [{ tip: 1000n, gas: 0n }, { tip: 5000n, gas: 0n }],
      [10, 50, 75, 90],
    )
    expect(out[10]).toBe(0n)
    expect(out[90]).toBe(0n)
  })

  it('reads percentiles correctly on a uniform-gas distribution', () => {
    // Equal gas across 5 tips → totalGas = 5 * g; targets land at 0.5g,
    // 2.5g, 3.75g, 4.5g of cumulative gas. Walking the sorted list:
    //   tip=10 (g),    cumul=g    → covers p < 20
    //   tip=20 (2g),   cumul=2g
    //   tip=30 (3g),   cumul=3g
    //   tip=40 (4g),   cumul=4g
    //   tip=50 (5g),   cumul=5g
    const samples: TipSample[] = [
      { tip: 10n, gas: 100n },
      { tip: 20n, gas: 100n },
      { tip: 30n, gas: 100n },
      { tip: 40n, gas: 100n },
      { tip: 50n, gas: 100n },
    ]
    const out = gasWeightedPercentiles(samples, [10, 50, 75, 90])
    expect(out[10]).toBe(10n)
    expect(out[50]).toBe(30n)
    expect(out[75]).toBe(40n)
    expect(out[90]).toBe(50n)
  })

  it('hides a small paying lane when its gas share is below the percentile', () => {
    // 95% of gas at tip=0, 5% at tip=1_000_000. Every percentile up to
    // p95 sits inside the spam lane; only above p95 does the paying lane
    // surface.
    const samples: TipSample[] = [
      { tip: 0n, gas: 9500n },
      { tip: 1_000_000n, gas: 500n },
    ]
    const out = gasWeightedPercentiles(samples, [10, 50, 75, 90, 95, 96])
    expect(out[10]).toBe(0n)
    expect(out[50]).toBe(0n)
    expect(out[75]).toBe(0n)
    expect(out[90]).toBe(0n)
    // p95 sits exactly at the spam lane's edge (cumul=9500 ≥ 9500). p96
    // requires cumul ≥ 9600, which only the paying lane satisfies.
    expect(out[95]).toBe(0n)
    expect(out[96]).toBe(1_000_000n)
  })

  it('reflects a 50/50 paying/spam split at p75/p90', () => {
    const samples: TipSample[] = [
      { tip: 0n, gas: 1000n },
      { tip: 1000n, gas: 1000n },
    ]
    const out = gasWeightedPercentiles(samples, [10, 50, 75, 90])
    expect(out[10]).toBe(0n)
    expect(out[50]).toBe(0n)
    expect(out[75]).toBe(1000n)
    expect(out[90]).toBe(1000n)
  })

  it('uses gas-weighting, not count-weighting', () => {
    // 99 spam txs at tip=0 (1 gas each) vs. 1 paying tx at tip=1000 (1000
    // gas). Count-weighting would put p50 at 0; gas-weighting puts it at
    // 1000 because the paying tx alone is half of total gas.
    const samples: TipSample[] = []
    for (let i = 0; i < 99; i++) samples.push({ tip: 0n, gas: 1n })
    samples.push({ tip: 1000n, gas: 1000n })

    const out = gasWeightedPercentiles(samples, [10, 50, 75, 90])
    // totalGas = 99 + 1000 = 1099; p50 target = 549.
    // Sorted: 99 zeros (cumul 99) then 1000 (cumul 1099). 1099 >= 549 → 1000.
    expect(out[50]).toBe(1000n)
    expect(out[75]).toBe(1000n)
    expect(out[90]).toBe(1000n)
  })

  it('does not mutate the caller-provided samples array', () => {
    const samples: TipSample[] = [
      { tip: 30n, gas: 1n },
      { tip: 10n, gas: 1n },
      { tip: 20n, gas: 1n },
    ]
    const tipsBefore = samples.map((s) => s.tip)
    gasWeightedPercentiles(samples, [50])
    expect(samples.map((s) => s.tip)).toEqual(tipsBefore)
  })

  it('is monotone in p across random fuzzed inputs', () => {
    const rng = (seed: number) => {
      let s = seed
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        return s / 0x7fffffff
      }
    }
    const random = rng(42)
    for (let trial = 0; trial < 20; trial++) {
      const n = Math.floor(random() * 50) + 1
      const samples: TipSample[] = Array.from({ length: n }, () => ({
        tip: BigInt(Math.floor(random() * 1_000_000)),
        gas: BigInt(Math.floor(random() * 100_000) + 1),
      }))
      const targets = [10, 25, 50, 75, 90]
      const out = gasWeightedPercentiles(samples, targets)
      for (let i = 1; i < targets.length; i++) {
        expect(out[targets[i]]).toBeGreaterThanOrEqual(out[targets[i - 1]])
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  blockToSample                                                             */
/* -------------------------------------------------------------------------- */

const buildBlock = (txs: RawTx[], baseFee: bigint = 1_000_000_000n): BlockResult => ({
  number: '0x1234',
  hash: '0xaaaa',
  parentHash: '0xbbbb',
  timestamp: '0x660a0000',
  baseFeePerGas: '0x' + baseFee.toString(16),
  gasLimit: '0x1c9c380',
  gasUsed: '0xe4e1c0',
  transactions: txs,
})

describe('blockToSample', () => {
  it('extracts tips from EIP-1559 txs only', () => {
    const sample = blockToSample(
      buildBlock([
        { maxPriorityFeePerGas: '0x64', maxFeePerGas: '0x77359400', gas: '0x5208', type: '0x2' },
        { maxPriorityFeePerGas: '0x12c', maxFeePerGas: '0x77359400', gas: '0x5208', type: '0x2' },
      ]),
    )
    expect(sample.tips).toHaveLength(2)
    expect(sample.tips[0]).toEqual({ tip: 100n, gas: 21000n, txType: 2 })
    expect(sample.tips[1]).toEqual({ tip: 300n, gas: 21000n, txType: 2 })
  })

  it('extracts tips from legacy (gasPrice) txs', () => {
    const sample = blockToSample(
      buildBlock(
        [{ gasPrice: '0x' + (1_000_000_500n).toString(16), gas: '0x5208', type: '0x0' }],
        1_000_000_000n,
      ),
    )
    expect(sample.tips).toHaveLength(1)
    expect(sample.tips[0]).toEqual({ tip: 500n, gas: 21000n, txType: 0 })
  })

  it('decodes various tx-type wire forms (0x, 0x0, 0x2, 0x4)', () => {
    const sample = blockToSample(
      buildBlock([
        { maxPriorityFeePerGas: '0x64', maxFeePerGas: '0x77359400', gas: '0x5208', type: '0x' },
        { maxPriorityFeePerGas: '0x64', maxFeePerGas: '0x77359400', gas: '0x5208', type: '0x0' },
        { maxPriorityFeePerGas: '0x64', maxFeePerGas: '0x77359400', gas: '0x5208', type: '0x2' },
        { maxPriorityFeePerGas: '0x64', maxFeePerGas: '0x77359400', gas: '0x5208', type: '0x4' },
      ]),
    )
    expect(sample.tips.map((t) => t.txType)).toEqual([0, 0, 2, 4])
  })

  it('leaves txType undefined when the type field is missing or malformed', () => {
    const sample = blockToSample(
      buildBlock([
        { gasPrice: '0x' + (1_000_000_500n).toString(16), gas: '0x5208' },
        { gasPrice: '0x' + (1_000_000_500n).toString(16), gas: '0x5208', type: 'garbage' },
      ]),
    )
    expect(sample.tips[0].txType).toBeUndefined()
    expect(sample.tips[1].txType).toBeUndefined()
  })

  it('handles a mixed block (1559 + legacy)', () => {
    const sample = blockToSample(
      buildBlock([
        { maxPriorityFeePerGas: '0x64', maxFeePerGas: '0x77359400', gas: '0x5208', type: '0x2' },
        { gasPrice: '0x' + (1_000_001_000n).toString(16), gas: '0xa410', type: '0x0' },
      ]),
    )
    expect(sample.tips).toHaveLength(2)
    expect(sample.tips[0].tip).toBe(100n)
    expect(sample.tips[1].tip).toBe(1000n)
  })

  it('returns an empty tips array on a tx-less block', () => {
    const sample = blockToSample(buildBlock([]))
    expect(sample.tips).toEqual([])
  })

  it('filters out txs missing the gas field', () => {
    const sample = blockToSample(
      buildBlock([
        { maxPriorityFeePerGas: '0x64', maxFeePerGas: '0x77359400', type: '0x2' }, // no gas
        { maxPriorityFeePerGas: '0xc8', maxFeePerGas: '0x77359400', gas: '0x5208', type: '0x2' },
      ]),
    )
    expect(sample.tips).toHaveLength(1)
    expect(sample.tips[0].tip).toBe(200n)
  })

  it('preserves the block-level fields used by the ring lifecycle', () => {
    const sample = blockToSample(buildBlock([], 5_000_000_000n))
    expect(sample.number).toBe(0x1234n)
    expect(sample.hash).toBe('0xaaaa')
    expect(sample.parentHash).toBe('0xbbbb')
    expect(sample.baseFee).toBe(5_000_000_000n)
    expect(sample.gasUsed).toBe(0xe4e1c0n)
  })
})

/* -------------------------------------------------------------------------- */
/*  computeTiers                                                              */
/* -------------------------------------------------------------------------- */

describe('computeTiers', () => {
  const baseFee = 1_000_000_000n // 1 gwei
  // Equal-gas samples so percentiles read off the sorted tip list directly.
  // Tips chosen so p10/p50/p75/p90 of the merged distribution are
  // 100/500/1000/2000 — values mirror the old fixture's spirit but the
  // tier numbers come from a single merged distribution now.
  const ringSamples: TipSample[] = [
    { tip: 100n, gas: 100n },
    { tip: 200n, gas: 100n },
    { tip: 500n, gas: 100n },
    { tip: 1000n, gas: 100n },
    { tip: 2000n, gas: 100n },
  ]
  const mempoolSamples: TipSample[] = [
    { tip: 150n, gas: 100n },
    { tip: 180n, gas: 100n },
    { tip: 600n, gas: 100n },
    { tip: 900n, gas: 100n },
    { tip: 2500n, gas: 100n },
  ]
  const blockNumber = 100n

  // Default to `flat` so the merged-distribution math tests below can
  // share the same fixtures (most lack txType). The default-priority-model
  // test ('defaults priorityModel to eip1559') overrides this back to
  // undefined to exercise the production default.
  const call = (overrides: Partial<Parameters<typeof computeTiers>[0]> = {}) =>
    computeTiers({
      ringSamples,
      mempoolSamples,
      baseFee,
      baseFeeTrend: Trend.stable,
      blob: null,
      blockNumber,
      lastPublishedTips: undefined,
      lastPublishedBlockNumber: undefined,
      priorityModel: PriorityModel.flat,
      ...overrides,
    })

  it('reads tiers from one merged gas-weighted distribution (not per-source max)', () => {
    // Combined sorted tips: [100, 150, 180, 200, 500, 600, 900, 1000, 2000, 2500]
    // 10 equal-gas samples → totalGas=1000; p10 target=100 (cumul 100 → tip=100),
    // p50 target=500 (cumul 500 → tip=500),
    // p75 target=750 (cumul 600 → tip=600 then 700 → still 600… cumul 700→still 600;
    //                cumul reaches 800 at tip 1000),
    // p90 target=900 (cumul 900 → tip 1000 hits at cumul 800 then 900 = tip 1000).
    // We assert the moved-tier behavior: standard now reflects p50 of the merged.
    const { tiers } = call()
    expect(tiers.slow.maxPriorityFeePerGas).toBe(100n)
    expect(tiers.standard.maxPriorityFeePerGas).toBe(500n)
    expect(tiers.fast.maxPriorityFeePerGas).toBe(1000n)
    expect(tiers.instant.maxPriorityFeePerGas).toBe(2000n)
  })

  it('applies the rising buffer (1.25x) to baseFee in maxFeePerGas', () => {
    const { tiers } = call({ baseFeeTrend: Trend.rising })
    expect(tiers.slow.maxFeePerGas).toBe(1_250_000_000n + 100n)
  })

  it('applies the stable buffer (1.125x) to baseFee in maxFeePerGas', () => {
    const { tiers } = call({ baseFeeTrend: Trend.stable })
    expect(tiers.slow.maxFeePerGas).toBe(1_125_000_000n + 100n)
  })

  it('applies the falling buffer (1x, no buffer) to baseFee', () => {
    const { tiers } = call({ baseFeeTrend: Trend.falling })
    expect(tiers.slow.maxFeePerGas).toBe(1_000_000_000n + 100n)
  })

  it('exposes gasPrice = baseFee + tip for legacy callers', () => {
    const { tiers } = call()
    expect(tiers.slow.gasPrice).toBe(baseFee + 100n)
    expect(tiers.instant.gasPrice).toBe(baseFee + 2000n)
  })

  it('sets maxFeePerBlobGas to null on chains without blob data', () => {
    const { tiers } = call()
    expect(tiers.slow.maxFeePerBlobGas).toBeNull()
    expect(tiers.fast.maxFeePerBlobGas).toBeNull()
  })

  it('buffers blobBaseFee using the blob trend', () => {
    const { tiers } = call({ blob: { blobBaseFee: 1000n, trend: Trend.rising } })
    // 1000 * 125 / 100 = 1250 — every tier gets the same blob fee
    expect(tiers.slow.maxFeePerBlobGas).toBe(1250n)
    expect(tiers.instant.maxFeePerBlobGas).toBe(1250n)
  })

  it('still produces tiers when the mempool is empty (ring-only)', () => {
    const { tiers } = call({ mempoolSamples: [] })
    // ring-only sorted tips: [100, 200, 500, 1000, 2000]
    // 5 equal-gas samples; totalGas=500.
    // p10 target=50 → tip=100; p50 target=250 → tip=500;
    // p75 target=375 → tip=500; p90 target=450 → tip=500.
    expect(tiers.slow.maxPriorityFeePerGas).toBe(100n)
    expect(tiers.standard.maxPriorityFeePerGas).toBe(500n)
  })

  it('returns publishedTips alongside tiers (for the next-poll cap anchor)', () => {
    const { publishedTips } = call()
    expect(publishedTips.slow).toBe(100n)
    expect(publishedTips.standard).toBe(500n)
    expect(publishedTips.fast).toBe(1000n)
    expect(publishedTips.instant).toBe(2000n)
  })

  it('clamps a crashed tip against the last-published 7/8 floor', () => {
    const lastPublishedTips = { slow: 5000n, standard: 5000n, fast: 5000n, instant: 5000n }
    const crashed: TipSample[] = [{ tip: 1n, gas: 100n }]
    const { tiers } = call({
      ringSamples: crashed,
      mempoolSamples: [],
      lastPublishedTips,
      lastPublishedBlockNumber: 99n,
    })
    expect(tiers.slow.maxPriorityFeePerGas).toBe(4375n)
    expect(tiers.instant.maxPriorityFeePerGas).toBe(4375n)
  })

  it('lets upside through the cap unclamped (real spikes propagate)', () => {
    const lastPublishedTips = { slow: 1000n, standard: 1000n, fast: 1000n, instant: 1000n }
    const surge: TipSample[] = [{ tip: 50000n, gas: 100n }]
    const { tiers } = call({
      ringSamples: surge,
      mempoolSamples: [],
      lastPublishedTips,
      lastPublishedBlockNumber: 99n,
    })
    expect(tiers.slow.maxPriorityFeePerGas).toBe(50000n)
    expect(tiers.instant.maxPriorityFeePerGas).toBe(50000n)
  })

  it("with priorityModel='eip1559', paying-lane tiers exclude legacy spam", () => {
    // Legacy spam at the bottom (lots of zero/low tips, large gas weight),
    // type-2 paying lane at the top (smaller gas weight, higher tips).
    // Under 'flat', spam pulls all tiers down. Under 'eip1559', slow still
    // sees spam but standard/fast/instant draw from type-2+ only.
    const ring: TipSample[] = [
      { tip: 0n, gas: 100n, txType: 0 },
      { tip: 0n, gas: 100n, txType: 0 },
      { tip: 0n, gas: 100n, txType: 0 },
      { tip: 100n, gas: 100n, txType: 0 },
      { tip: 5000n, gas: 100n, txType: 2 },
      { tip: 8000n, gas: 100n, txType: 2 },
      { tip: 12000n, gas: 100n, txType: 2 },
    ]
    const flat = call({ ringSamples: ring, mempoolSamples: [], priorityModel: PriorityModel.flat })
    const eip = call({ ringSamples: ring, mempoolSamples: [], priorityModel: PriorityModel.eip1559 })

    // Slow tier still draws from the full distribution under either model
    expect(flat.tiers.slow.maxPriorityFeePerGas).toBe(eip.tiers.slow.maxPriorityFeePerGas)

    // Paying-lane tiers diverge: 'eip1559' is strictly higher at the
    // mid-percentiles because it ignored the legacy spam. `instant` (p90)
    // can match between the two modes since the topmost paying-lane tip
    // is the topmost tip overall.
    expect(eip.tiers.standard.maxPriorityFeePerGas).toBeGreaterThan(
      flat.tiers.standard.maxPriorityFeePerGas,
    )
    expect(eip.tiers.fast.maxPriorityFeePerGas).toBeGreaterThan(
      flat.tiers.fast.maxPriorityFeePerGas,
    )
    expect(eip.tiers.instant.maxPriorityFeePerGas).toBeGreaterThanOrEqual(
      flat.tiers.instant.maxPriorityFeePerGas,
    )
  })

  it("with priorityModel='eip1559' and no type-2 samples, paying-lane tiers fall to 0", () => {
    // All-legacy distribution; nothing passes the type-2 filter.
    const allLegacy: TipSample[] = [
      { tip: 1000n, gas: 100n, txType: 0 },
      { tip: 2000n, gas: 100n, txType: 0 },
    ]
    const { tiers } = call({
      ringSamples: allLegacy,
      mempoolSamples: [],
      priorityModel: PriorityModel.eip1559,
    })
    // Slow still reads the full distribution
    expect(tiers.slow.maxPriorityFeePerGas).toBeGreaterThan(0n)
    // Paying lanes see an empty filtered set → 0n
    expect(tiers.standard.maxPriorityFeePerGas).toBe(0n)
    expect(tiers.fast.maxPriorityFeePerGas).toBe(0n)
    expect(tiers.instant.maxPriorityFeePerGas).toBe(0n)
  })

  it('defaults priorityModel to eip1559 when not provided', () => {
    // Mixed-type distribution: high-tip legacy spam + lower-tip type-2.
    // Under the eip1559 default, paying-lane tiers must come from
    // type-2-only samples — so the instant tier reflects the top type-2
    // tip (12n), NOT the top of the merged distribution (100n).
    const ring: TipSample[] = [
      { tip: 100n, gas: 100n, txType: 0 },
      { tip: 95n, gas: 100n, txType: 0 },
      { tip: 10n, gas: 100n, txType: 2 },
      { tip: 12n, gas: 100n, txType: 2 },
    ]
    // priorityModel: undefined overrides the helper's flat default
    // so this test exercises the production default in math.ts.
    const { tiers } = call({
      ringSamples: ring,
      mempoolSamples: [],
      priorityModel: undefined,
    })

    // Under eip1559 default, instant reads from {10n, 12n} only.
    expect(tiers.instant.maxPriorityFeePerGas).toBeLessThanOrEqual(12n)
    expect(tiers.instant.maxPriorityFeePerGas).toBeGreaterThan(0n)
    // Cross-check: the same input with explicit 'flat' yields the
    // higher legacy-spam tip — proves the default truly is eip1559.
    const flat = call({
      ringSamples: ring,
      mempoolSamples: [],
      priorityModel: PriorityModel.flat,
    })
    expect(flat.tiers.instant.maxPriorityFeePerGas).toBeGreaterThan(
      tiers.instant.maxPriorityFeePerGas,
    )
  })

  it('honors a custom priorityFeeDecayCap (50%/block)', () => {
    const WAD = 1_000_000_000_000_000_000n
    const lastPublishedTips = { slow: 1000n, standard: 1000n, fast: 1000n, instant: 1000n }
    const crashed: TipSample[] = [{ tip: 0n, gas: 100n, txType: 2 }]
    const { tiers } = call({
      ringSamples: crashed,
      mempoolSamples: [],
      lastPublishedTips,
      lastPublishedBlockNumber: 99n,
      blockNumber: 100n,
      priorityFeeDecayCap: WAD / 2n, // 50%/block
    })
    // 1000 * 0.5 = 500 floor after one block
    expect(tiers.slow.maxPriorityFeePerGas).toBe(500n)
    expect(tiers.instant.maxPriorityFeePerGas).toBe(500n)
  })

  it('disables capping entirely when priorityFeeDecayCap is null', () => {
    const lastPublishedTips = { slow: 1000n, standard: 1000n, fast: 1000n, instant: 1000n }
    const crashed: TipSample[] = [{ tip: 1n, gas: 100n, txType: 2 }]
    const { tiers } = call({
      ringSamples: crashed,
      mempoolSamples: [],
      lastPublishedTips,
      lastPublishedBlockNumber: 99n,
      priorityFeeDecayCap: null,
    })
    expect(tiers.slow.maxPriorityFeePerGas).toBe(1n)
    expect(tiers.instant.maxPriorityFeePerGas).toBe(1n)
  })

  it('compounds the base-fee buffer across N liveness blocks (rising)', () => {
    // Default rising at N=1 → 1.25×. With N=6, rising → (9/8)^6 × 10/9
    // = 5_314_410 / 2_359_296. baseFee=1e9 → bufferedBase = 1e9 × num/den.
    const { tiers: oneBlock } = call({ baseFeeTrend: Trend.rising })
    const { tiers: sixBlock } = call({ baseFeeTrend: Trend.rising, baseFeeLivenessBlocks: 6 })
    expect(sixBlock.slow.maxFeePerGas).toBeGreaterThan(oneBlock.slow.maxFeePerGas)
    // 1e9 × 5314410 / 2359296 + tip(100) = 2_252_540_688 (bigint, integer-divided)
    expect(sixBlock.slow.maxFeePerGas).toBe(2_252_540_688n)
  })

  it('compounds the base-fee buffer across N liveness blocks (stable)', () => {
    const { tiers } = call({ baseFeeTrend: Trend.stable, baseFeeLivenessBlocks: 6 })
    // stable at N=6: (9/8)^6 = 531441 / 262144
    // baseFee=1e9 × 531441 / 262144 + tip(100) = 2_027_286_629
    expect(tiers.slow.maxFeePerGas).toBe(2_027_286_629n)
  })

  it('keeps the base-fee buffer at 1× under falling trend regardless of N', () => {
    const { tiers: oneBlock } = call({ baseFeeTrend: Trend.falling })
    const { tiers: sixBlock } = call({
      baseFeeTrend: Trend.falling,
      baseFeeLivenessBlocks: 6,
    })
    expect(sixBlock.slow.maxFeePerGas).toBe(oneBlock.slow.maxFeePerGas)
  })

  it('compounds the blob-base-fee buffer with the same liveness window', () => {
    const { tiers } = call({
      blob: { blobBaseFee: 1000n, trend: Trend.stable },
      baseFeeLivenessBlocks: 6,
    })
    // 1000 * 531441 / 262144 = 2027 (integer division)
    expect(tiers.slow.maxFeePerBlobGas).toBe(2027n)
  })
})

/* -------------------------------------------------------------------------- */
/*  computeBlobBaseFee                                                        */
/* -------------------------------------------------------------------------- */

describe('computeBlobBaseFee', () => {
  it('returns 1n when excessBlobGas is zero (MIN_BLOB_BASE_FEE)', () => {
    expect(computeBlobBaseFee(0n)).toBe(1n)
  })

  it('returns a positive value for non-zero excessBlobGas', () => {
    expect(computeBlobBaseFee(1_048_576n)).toBeGreaterThan(0n)
  })

  it('grows monotonically with excessBlobGas', () => {
    const a = computeBlobBaseFee(1_000_000n)
    const b = computeBlobBaseFee(10_000_000n)
    expect(b).toBeGreaterThan(a)
  })
})

/* -------------------------------------------------------------------------- */
/*  flattenTxPool                                                             */
/* -------------------------------------------------------------------------- */

describe('flattenTxPool', () => {
  it('flattens sender → nonce → tx into a flat tx array', () => {
    const pool = {
      '0xabc': {
        '1': { gasPrice: '0x1', type: '0x0' },
        '2': { gasPrice: '0x2', type: '0x0' },
      },
      '0xdef': {
        '0': { gasPrice: '0x3', type: '0x0' },
      },
    }
    const txs = flattenTxPool(pool)
    expect(txs).toHaveLength(3)
  })

  it('returns an empty array for null/undefined input', () => {
    expect(flattenTxPool(null)).toEqual([])
    expect(flattenTxPool(undefined)).toEqual([])
  })

  it('returns an empty array for an empty pool object', () => {
    expect(flattenTxPool({})).toEqual([])
  })
})
