import { describe, expect, it } from 'vitest'
import {
  minimumReplacementFee,
  bumpForReplacement,
  recommendBumpTier,
  BumpStrategy,
  ReplacementBumpPercent,
} from './replacement.js'
import {
  TierName,
  Trend,
  TxType,
  type GasOracleState,
  type TipSample,
} from './types.js'

describe('minimumReplacementFee', () => {
  // Table: [current, txType, expectedMinimum]
  // Verified against geth/legacypool list.go:Add — both
  // strict-greater-than and >=110% threshold checks.
  const cases: Array<[bigint, number, bigint]> = [
    [0n, TxType.eip1559, 1n], // floor=0, +1 to clear strict-greater
    [1n, TxType.eip1559, 2n], // floor=floor(11/10)=1, +1
    [9n, TxType.eip1559, 10n], // floor=floor(99/10)=9, +1
    [10n, TxType.eip1559, 12n], // floor=floor(110/10)=11, +1
    [80n, TxType.eip1559, 89n], // floor=floor(880/10)=88, +1
    [83n, TxType.eip1559, 92n], // floor=floor(913/10)=91, +1
    [100n, TxType.eip1559, 111n], // floor=110, +1
    [0n, TxType.legacy, 1n], // legacy uses default bump, current=0 → +1
  ]

  it.each(cases)(
    'current=%s txType=%s → minimum=%s',
    (current, txType, expected) => {
      expect(minimumReplacementFee(current, txType)).toBe(expected)
    },
  )

  it('blob txs use +100% bump', () => {
    expect(minimumReplacementFee(100n, TxType.blob)).toBe(201n)
    expect(minimumReplacementFee(0n, TxType.blob)).toBe(1n)
    expect(minimumReplacementFee(50n, TxType.blob)).toBe(101n)
  })

  it('unknown future txTypes default to legacy bump', () => {
    expect(minimumReplacementFee(100n, 99)).toBe(111n)
  })
})

describe('ReplacementBumpPercent', () => {
  it('exposes the geth/reth defaults', () => {
    expect(ReplacementBumpPercent.default).toBe(10n)
    expect(ReplacementBumpPercent.blob).toBe(100n)
  })
})

describe('bumpForReplacement', () => {
  it('returns max(target, protocolFloor) for both fields', () => {
    const current = { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }
    const target = { maxFeePerGas: 200n, maxPriorityFeePerGas: 50n }
    const result = bumpForReplacement(current, target)
    expect(result).toEqual({ maxFeePerGas: 200n, maxPriorityFeePerGas: 50n })
  })

  it('uses protocol floor when target is below it', () => {
    const current = { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }
    const target = { maxFeePerGas: 50n, maxPriorityFeePerGas: 5n }
    const result = bumpForReplacement(current, target)
    expect(result.maxFeePerGas).toBe(111n)
    expect(result.maxPriorityFeePerGas).toBe(12n)
  })

  it('guarantees maxFeePerGas >= maxPriorityFeePerGas (well-formed tx)', () => {
    const current = { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }
    const target = { maxFeePerGas: 10n, maxPriorityFeePerGas: 200n }
    const result = bumpForReplacement(current, target)
    expect(result.maxFeePerGas).toBeGreaterThanOrEqual(
      result.maxPriorityFeePerGas,
    )
  })
})

const buildTiers = (
  slow: bigint,
  standard: bigint,
  fast: bigint,
  instant: bigint,
): GasOracleState['tiers'] => ({
  [TierName.slow]: {
    maxPriorityFeePerGas: slow,
    maxFeePerGas: slow * 2n,
    gasPrice: slow * 2n,
    maxFeePerBlobGas: null,
  },
  [TierName.standard]: {
    maxPriorityFeePerGas: standard,
    maxFeePerGas: standard * 2n,
    gasPrice: standard * 2n,
    maxFeePerBlobGas: null,
  },
  [TierName.fast]: {
    maxPriorityFeePerGas: fast,
    maxFeePerGas: fast * 2n,
    gasPrice: fast * 2n,
    maxFeePerBlobGas: null,
  },
  [TierName.instant]: {
    maxPriorityFeePerGas: instant,
    maxFeePerGas: instant * 2n,
    gasPrice: instant * 2n,
    maxFeePerBlobGas: null,
  },
})

const buildSnapshot = (
  tiers: GasOracleState['tiers'],
  mempoolSamples: TipSample[] = [],
): GasOracleState => ({
  chainId: 1,
  blockNumber: 100n,
  timestamp: 0n,
  baseFee: 1n,
  baseFeeTrend: Trend.stable,
  baseFeeHistory: [1n],
  mempool: {
    pendingCount: 0n,
    queuedCount: 0n,
    pendingGasDemand: 0n,
    blockGasLimit: 30_000_000n,
  },
  blob: null,
  tiers,
  ring: [],
  mempoolSamples,
})

describe('BumpStrategy', () => {
  it('exposes three named strategies', () => {
    expect(BumpStrategy.cheapestThatLands).toBe('cheapestThatLands')
    expect(BumpStrategy.oneStepFasterThanRecommended).toBe(
      'oneStepFasterThanRecommended',
    )
    expect(BumpStrategy.instant).toBe('instant')
  })
})

describe('recommendBumpTier', () => {
  const tiers = buildTiers(10n, 50n, 100n, 200n)
  const snapshot = buildSnapshot(tiers)

  it('default strategy is cheapestThatLands — picks lowest tier above protocol floor', () => {
    expect(recommendBumpTier(snapshot, { priorityTip: 5n })).toBe(TierName.slow)
  })

  it('cheapestThatLands strategy — explicit', () => {
    expect(
      recommendBumpTier(
        snapshot,
        { priorityTip: 30n },
        { strategy: BumpStrategy.cheapestThatLands },
      ),
    ).toBe(TierName.standard)
  })

  it('oneStepFasterThanRecommended bumps one tier above cheapest', () => {
    expect(
      recommendBumpTier(
        snapshot,
        { priorityTip: 5n },
        { strategy: BumpStrategy.oneStepFasterThanRecommended },
      ),
    ).toBe(TierName.standard)
  })

  it('oneStepFasterThanRecommended caps at instant', () => {
    expect(
      recommendBumpTier(
        snapshot,
        { priorityTip: 110n },
        { strategy: BumpStrategy.oneStepFasterThanRecommended },
      ),
    ).toBe(TierName.instant)
  })

  it('instant strategy returns instant when it clears the floor', () => {
    expect(
      recommendBumpTier(
        snapshot,
        { priorityTip: 5n },
        { strategy: BumpStrategy.instant },
      ),
    ).toBe(TierName.instant)
  })

  it('returns null when even instant does not clear the protocol floor', () => {
    expect(recommendBumpTier(snapshot, { priorityTip: 200n })).toBeNull()
  })

  it('outpace correction raises the floor when stuck-tx identifier provided', () => {
    const stuckHash = '0xstuck'
    const stuckSamples: TipSample[] = [
      {
        tip: 30n,
        gas: 21_000n,
        txType: TxType.eip1559,
        hash: stuckHash,
        address: '0x1',
        nonce: '1',
      },
      {
        tip: 60n,
        gas: 21_000n,
        txType: TxType.eip1559,
        hash: '0xother',
        address: '0x2',
        nonce: '1',
      },
    ]
    const snapshotWithMempool = buildSnapshot(tiers, stuckSamples)
    expect(
      recommendBumpTier(snapshotWithMempool, {
        priorityTip: 30n,
        identifier: { hash: stuckHash },
      }),
    ).toBe(TierName.fast)
  })

  it('outpace identifier missing in mempool falls back to protocol floor', () => {
    const snapshotEmpty = buildSnapshot(tiers, [])
    expect(
      recommendBumpTier(snapshotEmpty, {
        priorityTip: 5n,
        identifier: { hash: '0xnotpresent' },
      }),
    ).toBe(TierName.slow)
  })

  it('outpace correction is 0 when stuck is already at rank 0 (top of distribution)', () => {
    // Stuck at top — no one to outpace, so outpaceFloor=0 and only the
    // protocol floor applies. priorityTip=5n → protocolFloor=6n → slow
    // tier (10n) clears it.
    const stuckHash = '0xtopstuck'
    const stuckSamples: TipSample[] = [
      {
        tip: 100n,
        gas: 21_000n,
        txType: TxType.eip1559,
        hash: stuckHash,
        address: '0x1',
        nonce: '1',
      },
      {
        tip: 50n,
        gas: 21_000n,
        txType: TxType.eip1559,
        hash: '0xbelow',
        address: '0x2',
        nonce: '1',
      },
    ]
    const snapshotWithMempool = buildSnapshot(tiers, stuckSamples)
    expect(
      recommendBumpTier(snapshotWithMempool, {
        priorityTip: 5n,
        identifier: { hash: stuckHash },
      }),
    ).toBe(TierName.slow)
  })

  it('returns null on empty/zero tiers', () => {
    const zeroSnapshot = buildSnapshot(buildTiers(0n, 0n, 0n, 0n))
    expect(recommendBumpTier(zeroSnapshot, { priorityTip: 0n })).toBeNull()
  })
})
