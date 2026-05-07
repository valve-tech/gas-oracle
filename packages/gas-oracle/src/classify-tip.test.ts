import { describe, expect, it } from 'vitest'
import { classifyTip } from './classify-tip.js'
import { TierName, Trend, TxType, type GasOracleState, type TipSample } from './types.js'

const buildSnapshot = (
  tiers: GasOracleState['tiers'],
  mempoolSamples: TipSample[] = [],
  ringTips: TipSample[] = [],
): GasOracleState => ({
  chainId: 1,
  blockNumber: 100n,
  timestamp: 0n,
  baseFee: 1n,
  baseFeeTrend: Trend.stable,
  baseFeeHistory: [1n],
  mempool: { pendingCount: 0n, queuedCount: 0n, pendingGasDemand: 0n, blockGasLimit: 30_000_000n },
  blob: null,
  tiers,
  ring: ringTips.length === 0 ? [] : [{
    number: 99n,
    hash: '0xb',
    parentHash: '0xp',
    baseFee: 1n,
    gasUsed: 0n,
    tips: ringTips,
  }],
  mempoolSamples,
})

const tiers: GasOracleState['tiers'] = {
  [TierName.slow]: { maxPriorityFeePerGas: 10n, maxFeePerGas: 20n, gasPrice: 20n, maxFeePerBlobGas: null },
  [TierName.standard]: { maxPriorityFeePerGas: 50n, maxFeePerGas: 100n, gasPrice: 100n, maxFeePerBlobGas: null },
  [TierName.fast]: { maxPriorityFeePerGas: 100n, maxFeePerGas: 200n, gasPrice: 200n, maxFeePerBlobGas: null },
  [TierName.instant]: { maxPriorityFeePerGas: 200n, maxFeePerGas: 400n, gasPrice: 400n, maxFeePerBlobGas: null },
}

describe('classifyTip', () => {
  it('tip below slow → tier null, requiredForNextTier = slow floor', () => {
    const result = classifyTip(buildSnapshot(tiers), 5n)
    expect(result.tier).toBeNull()
    expect(result.requiredForNextTier).toBe(10n)
  })

  it('tip exactly at slow → tier slow, requiredForNextTier = standard floor', () => {
    const result = classifyTip(buildSnapshot(tiers), 10n)
    expect(result.tier).toBe(TierName.slow)
    expect(result.requiredForNextTier).toBe(50n)
  })

  it('tip in standard band', () => {
    const result = classifyTip(buildSnapshot(tiers), 75n)
    expect(result.tier).toBe(TierName.standard)
    expect(result.requiredForNextTier).toBe(100n)
  })

  it('tip at instant → tier instant, requiredForNextTier null', () => {
    const result = classifyTip(buildSnapshot(tiers), 250n)
    expect(result.tier).toBe(TierName.instant)
    expect(result.requiredForNextTier).toBeNull()
  })

  it('empty distribution → percentile/rank/gasFromTop all 0n', () => {
    const result = classifyTip(buildSnapshot(tiers), 50n)
    expect(result.percentile).toBe(0n)
    expect(result.rank).toBe(0n)
    expect(result.gasFromTop).toBe(0n)
  })

  it('with samples → percentile/rank/gasFromTop reflect distribution', () => {
    const samples: TipSample[] = [
      { tip: 100n, gas: 21_000n, txType: TxType.eip1559, hash: '0xa', address: '0x1', nonce: '1' },
      { tip: 80n, gas: 21_000n, txType: TxType.eip1559, hash: '0xb', address: '0x2', nonce: '1' },
      { tip: 60n, gas: 21_000n, txType: TxType.eip1559, hash: '0xc', address: '0x3', nonce: '1' },
      { tip: 40n, gas: 21_000n, txType: TxType.eip1559, hash: '0xd', address: '0x4', nonce: '1' },
    ]
    // Sorted desc by tip: 100, 80, 60, 40 — tip=70 lands between 80 and 60 (rank=2)
    const result = classifyTip(buildSnapshot(tiers, samples), 70n)
    expect(result.rank).toBe(2n)
    expect(result.percentile).toBe(50n)
    expect(result.gasFromTop).toBe(42_000n)
  })

  it('combines mempool + ring samples for distribution', () => {
    const mempoolSamples: TipSample[] = [
      { tip: 100n, gas: 21_000n, txType: TxType.eip1559, hash: '0xm1', address: '0x1', nonce: '1' },
    ]
    const ringTips: TipSample[] = [
      { tip: 80n, gas: 21_000n, txType: TxType.eip1559, hash: '0xr1', address: '0x2', nonce: '1' },
    ]
    const result = classifyTip(buildSnapshot(tiers, mempoolSamples, ringTips), 90n)
    expect(result.rank).toBe(1n)
  })

  it('tip strictly below every sample → rank lands at distribution end', () => {
    const samples: TipSample[] = [
      { tip: 100n, gas: 21_000n, txType: TxType.eip1559, hash: '0xa', address: '0x1', nonce: '1' },
      { tip: 80n, gas: 21_000n, txType: TxType.eip1559, hash: '0xb', address: '0x2', nonce: '1' },
    ]
    // tip=5 strictly below all samples — findIndex(s => s.tip <= 5n) returns -1
    // → rank = len, gasFromTop accumulates over the entire distribution.
    const result = classifyTip(buildSnapshot(tiers, samples), 5n)
    expect(result.rank).toBe(2n)
    expect(result.percentile).toBe(100n)
    expect(result.gasFromTop).toBe(42_000n)
  })
})
