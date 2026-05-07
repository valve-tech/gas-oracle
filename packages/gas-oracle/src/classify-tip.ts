/**
 * Inverse of `tipForBlockPosition`. Given a tip and a snapshot, find
 * where the tip would land in the live distribution and which named
 * tier it falls in. Pure: no I/O, no oracle dependency, no wall-clock.
 *
 * Useful for "you priced at the Xth percentile" UI affordances and for
 * post-hoc "why is my tx slow" diagnostics.
 */

import {
  TIER_LADDER,
  TierName,
  type GasOracleState,
  type TipSample,
} from './types.js'

export interface ClassifyTipResult {
  /**
   * Named tier the tip falls in. `null` when below `TierName.slow`'s
   * `maxPriorityFeePerGas` floor.
   */
  tier: TierName | null
  /**
   * `maxPriorityFeePerGas` floor of the next tier above `tier`. `null`
   * when `tier === TierName.instant` (already at top).
   */
  requiredForNextTier: bigint | null
  /**
   * Approximate percentile in the live distribution (block ring tips +
   * mempool samples), 0n..100n. `0n` = top of block (highest tip);
   * `100n` = bottom. `0n` when distribution empty.
   */
  percentile: bigint
  /** Approximate rank, 0n-indexed from top. `0n` when distribution empty. */
  rank: bigint
  /** Accumulated gas above this tip's position. `0n` when empty. */
  gasFromTop: bigint
}

const tierForTip = (
  tiers: GasOracleState['tiers'],
  tipWei: bigint,
): TierName | null => {
  for (let i = TIER_LADDER.length - 1; i >= 0; i -= 1) {
    const tier = TIER_LADDER[i]
    if (tipWei >= tiers[tier].maxPriorityFeePerGas) return tier
  }
  return null
}

const requiredForNextTierAbove = (
  tiers: GasOracleState['tiers'],
  currentTier: TierName | null,
): bigint | null => {
  const currentIndex = currentTier ? TIER_LADDER.indexOf(currentTier) : -1
  const nextIndex = currentIndex + 1
  if (nextIndex >= TIER_LADDER.length) return null
  return tiers[TIER_LADDER[nextIndex]].maxPriorityFeePerGas
}

const collectDistribution = (snapshot: GasOracleState): TipSample[] => [
  ...snapshot.ring.flatMap((block) => block.tips),
  ...snapshot.mempoolSamples,
]

export const classifyTip = (
  snapshot: GasOracleState,
  tipWei: bigint,
): ClassifyTipResult => {
  const tier = tierForTip(snapshot.tiers, tipWei)
  const requiredForNextTier = requiredForNextTierAbove(snapshot.tiers, tier)

  const samples = collectDistribution(snapshot)
  if (samples.length === 0) {
    return { tier, requiredForNextTier, percentile: 0n, rank: 0n, gasFromTop: 0n }
  }

  // Sort by tip desc, equal-tip arm folded into descending side
  // (matches block-position.ts convention).
  const sorted = [...samples].sort((a, b) => (a.tip > b.tip ? -1 : 1))
  const firstWeakerIndexNum = sorted.findIndex((s) => s.tip <= tipWei)
  const samplesLen = BigInt(sorted.length)
  const rank: bigint = firstWeakerIndexNum === -1
    ? samplesLen
    : BigInt(firstWeakerIndexNum)

  // Round-half-away-from-zero percentile, all bigint. samplesLen >= 1n
  // is guaranteed by the early-return on empty samples above.
  const percentile = (rank * 100n + samplesLen / 2n) / samplesLen

  let gasFromTop = 0n
  for (let i = 0n; i < rank; i += 1n) gasFromTop += sorted[Number(i)].gas

  return { tier, requiredForNextTier, percentile, rank, gasFromTop }
}
