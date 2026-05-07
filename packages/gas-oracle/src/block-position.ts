/**
 * Block-position calculator.
 *
 * Validators include txs in *gas-weighted tip-descending order* — high
 * tip-per-gas at the top of the block, low tip-per-gas at the bottom.
 * "Position in the block" therefore has two natural axes:
 *
 *   1. **Rank** — count from the top. Position 0 is the highest-tip tx.
 *   2. **Gas offset** — accumulated gas consumed by all higher-tip txs.
 *      Position is "I want my tx mined within the first 1M gas of the
 *      block" → walk samples in tip-desc order, sum gas, find the
 *      pivot whose cumulative cross 1M.
 *
 * Both axes resolve to the same machinery — pick a pivot in the
 * sorted-by-tip-desc sample list, return the tip you'd need to pay to
 * outbid it.
 *
 * `tipForBlockPosition` returns the *minimum* tip to land at the
 * requested position; callers should add their own buffer for finality.
 * Equality at the same tip is validator-policy-dependent and not
 * guaranteed, so "outbid by 1 wei" is the honest minimum.
 */

import type { TipSample } from './types.js'
import type { TxIdentifier } from './mempool.js'

/**
 * What position to target in the gas-weighted, tip-descending order
 * of a block. Discriminated by `kind`:
 *
 * - `'rank'`         — `rank` is 0-indexed from the top (highest tip).
 *                      `rank: 0` → land at the very top; `rank: 4` →
 *                      land in 5th place.
 * - `'percentile'`   — `percentile` is `[0, 100]` from the top.
 *                      `percentile: 5` → I want to be in the top 5%.
 * - `'gasFromTop'`   — `gas` is a bigint of cumulative gas from the
 *                      block top. `gas: 1_000_000n` → land within the
 *                      first 1M gas of the block.
 * - `'aheadOf'`      — beat out a specific tx in the distribution.
 *                      Useful for MEV-style "I just need to outrank
 *                      this swap" targeting.
 * - `'behind'`       — be just behind a specific tx (still mine in the
 *                      same block, but pay less). Useful for piggybacking
 *                      on a high-tip tx that's already going to displace
 *                      pressure.
 *
 * Discriminated-union over flat-options-with-mode: per project style,
 * fields whose presence depends on the kind belong inside the kind's
 * variant, not flattened with `?`-marks.
 */
export type BlockPositionQuery =
  | { kind: 'rank'; rank: bigint }
  | { kind: 'percentile'; percentile: bigint }
  | { kind: 'gasFromTop'; gas: bigint }
  | { kind: 'aheadOf'; tx: TxIdentifier }
  | { kind: 'behind'; tx: TxIdentifier }

export interface BlockPositionResult {
  /**
   * Minimum tip-per-gas to definitively land at the requested position.
   * For `aheadOf` and `gasFromTop`/`rank`/`percentile` queries, this is
   * `pivot.tip + 1n` (one wei above the tx at the boundary). For
   * `behind`, this is `max(pivot.tip - 1n, 0n)`. Returns `0n` when the
   * distribution is empty or the position is below everyone.
   */
  requiredTip: bigint
  /**
   * The sample at the boundary — the tx you're outbidding (or
   * undercutting). `null` when the requested position is outside the
   * distribution (e.g. `rank: 1000` in a 50-tx block) or the
   * distribution is empty.
   */
  pivot: TipSample | null
  /** Approximate rank of the resolved position, 0-indexed from top. */
  rank: bigint
  /** Approximate gas-from-top of the resolved position. */
  gasFromTop: bigint
}

const sortByTipDesc = (samples: TipSample[]): TipSample[] =>
  // Equal-tip arm folded into the descending side — order between
  // equal-tip samples is unspecified and consumers shouldn't rely on
  // it (mempool ordering is provider-dependent anyway).
  [...samples].sort((a, b) => (a.tip > b.tip ? -1 : 1))

const matchesIdentifier = (sample: TipSample, id: TxIdentifier): boolean => {
  if ('hash' in id) {
    return (
      typeof sample.hash === 'string' &&
      sample.hash.toLowerCase() === id.hash.toLowerCase()
    )
  }
  if (sample.address === undefined || sample.nonce === undefined) return false
  if (sample.address.toLowerCase() !== id.address.toLowerCase()) return false
  return sample.nonce === BigInt(id.nonce).toString()
}

/**
 * Walk samples in tip-desc order accumulating gas; return the index
 * (0-based from top) where cumulative gas first crosses `targetGas`.
 * Returns -1n when the target exceeds the sum of all gas (the position
 * is below the whole distribution).
 */
const indexAtGasOffset = (sorted: TipSample[], targetGas: bigint): bigint => {
  if (targetGas <= 0n) return 0n
  let cumulative = 0n
  const len = BigInt(sorted.length)
  for (let i = 0n; i < len; i += 1n) {
    cumulative += sorted[Number(i)].gas
    if (cumulative > targetGas) return i
  }
  return -1n
}

const sumGasUpTo = (sorted: TipSample[], indexExclusive: bigint): bigint => {
  let g = 0n
  const len = BigInt(sorted.length)
  const upper = indexExclusive < len ? indexExclusive : len
  for (let i = 0n; i < upper; i += 1n) g += sorted[Number(i)].gas
  return g
}

const empty = (): BlockPositionResult => ({
  requiredTip: 0n,
  pivot: null,
  rank: 0n,
  gasFromTop: 0n,
})

/**
 * Compute the tip required to land at the requested position in the
 * next block, given a sample distribution (typically the merged ring
 * + mempool samples that `computeTiers` consumes, but any
 * `TipSample[]` works — pass just block samples for "would I have
 * landed in the last block?" hindsight).
 *
 * Pure: no I/O, no oracle dependency, no wall-clock. Test by feeding
 * fixture samples and asserting the returned shape.
 */
export const tipForBlockPosition = (
  samples: TipSample[],
  query: BlockPositionQuery,
): BlockPositionResult => {
  if (samples.length === 0) return empty()
  const sorted = sortByTipDesc(samples)
  const len = BigInt(sorted.length)

  let pivotIndex: bigint
  let beatPivot: boolean // true = outbid (tip+1), false = undercut (tip-1)

  switch (query.kind) {
    case 'rank': {
      pivotIndex = query.rank
      beatPivot = true
      break
    }
    case 'percentile': {
      // 0% = top of block (highest tip); 100% = bottom. Clamp to [0n, 100n].
      const pct =
        query.percentile < 0n
          ? 0n
          : query.percentile > 100n
            ? 100n
            : query.percentile
      pivotIndex = (len * pct) / 100n
      // Edge: percentile=100 lands at length, which is "below everything"
      if (pivotIndex >= len) pivotIndex = len - 1n
      beatPivot = true
      break
    }
    case 'gasFromTop': {
      pivotIndex = indexAtGasOffset(sorted, query.gas)
      beatPivot = true
      break
    }
    case 'aheadOf':
    case 'behind': {
      const found = sorted.findIndex((s) => matchesIdentifier(s, query.tx))
      pivotIndex = found === -1 ? -1n : BigInt(found)
      beatPivot = query.kind === 'aheadOf'
      break
    }
  }

  if (pivotIndex < 0n || pivotIndex >= len) {
    // Position is below everyone (or pivot not found) — pay nothing in priority
    return {
      requiredTip: 0n,
      pivot: null,
      rank: len,
      gasFromTop: sumGasUpTo(sorted, len),
    }
  }

  const pivot = sorted[Number(pivotIndex)]
  const requiredTip = beatPivot
    ? pivot.tip + 1n
    : pivot.tip > 0n
      ? pivot.tip - 1n
      : 0n

  return {
    requiredTip,
    pivot,
    rank: pivotIndex,
    gasFromTop: sumGasUpTo(sorted, pivotIndex),
  }
}
