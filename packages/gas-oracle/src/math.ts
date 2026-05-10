/**
 * Pure math primitives for the gas oracle. No I/O, no state — every
 * function is referentially transparent and exhaustively unit-testable.
 *
 * The math is the load-bearing wall: tier recommendations are only as
 * trustworthy as `effectiveTip` and `cappedTip`, so every edge case
 * (legacy txs, EIP-1559 with zero headroom, cold-start cap, post-EIP-4844
 * blob fee) is handled here rather than at higher layers.
 */

import type { RawTx } from '@valve-tech/chain-source'

import {
  PriorityModel,
  TierName,
  Trend,
  TxType,
  type TierRecommendation,
  type TipPercentiles,
  type TipSample,
} from './types.js'

const TREND_RISING_THRESHOLD_PCT = 10n
const TREND_FALLING_THRESHOLD_PCT = -10n

/**
 * 1e18, the EVM-native fixed-point scale. All caller-facing fractional
 * config knobs are bigints expressed against this scale — i.e.
 * `parseEther('0.125')` for 12.5%. Internal-only; the public surface
 * teaches callers to construct values via viem's `parseEther`, not via
 * a valve-specific WAD export.
 */
const WAD = 1_000_000_000_000_000_000n

/** Default priority-fee decay cap = 12.5% / block (EIP-1559 parity). */
export const DEFAULT_PRIORITY_FEE_DECAY_CAP = WAD / 8n

/**
 * Effective per-gas tip a validator sees for one transaction.
 *
 * EIP-1559 (has both maxPriority + maxFee):
 *   tip = min(maxPriorityFeePerGas, maxFeePerGas - baseFee)
 * Legacy (gasPrice only):
 *   tip = gasPrice - baseFee   (clamped at 0)
 *
 * Returns 0n when fee fields are missing or the math would go negative.
 */
export const effectiveTip = (tx: RawTx, baseFee: bigint): bigint => {
  if (tx.maxFeePerGas && tx.maxPriorityFeePerGas) {
    const maxFee = BigInt(tx.maxFeePerGas)
    const maxPriority = BigInt(tx.maxPriorityFeePerGas)
    const headroom = maxFee - baseFee
    if (headroom <= 0n) return 0n
    return maxPriority < headroom ? maxPriority : headroom
  }

  if (tx.gasPrice) {
    const price = BigInt(tx.gasPrice)
    return price > baseFee ? price - baseFee : 0n
  }

  return 0n
}

/**
 * p10/p25/p50/p75/p90 from a pre-sorted ascending bigint array. Empty
 * input returns all-zeros so callers can treat absence-of-data the same
 * way as a quiet block.
 */
export const computePercentiles = (sorted: bigint[]): TipPercentiles => {
  if (sorted.length === 0) {
    return { p10: 0n, p25: 0n, p50: 0n, p75: 0n, p90: 0n }
  }
  const at = (pct: number): bigint => {
    const idx = Math.min(Math.floor(sorted.length * pct), sorted.length - 1)
    return sorted[idx]
  }
  return { p10: at(0.1), p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9) }
}

/**
 * Sort a tx array by effective tip (ascending) and return the bigints.
 * Convenience wrapper so callers don't have to remember the comparator.
 */
export const sortedTips = (txs: RawTx[], baseFee: bigint): bigint[] =>
  txs
    .map((tx) => effectiveTip(tx, baseFee))
    // Equal-key arm is fine to fold into the >= side — the result is
    // a sorted list, not a stable sort by identity.
    .sort((a, b) => (a < b ? -1 : 1))

/**
 * Classify a base-fee history as rising, falling, or stable. Threshold
 * is ±10% comparing first to last value. Single-element or empty input
 * returns 'stable'.
 */
export const detectTrend = (history: bigint[]): Trend => {
  if (history.length < 2) return Trend.stable
  const first = history[0]
  const last = history[history.length - 1]
  if (first === 0n) return last > 0n ? Trend.rising : Trend.stable
  const change = ((last - first) * 100n) / first
  if (change > TREND_RISING_THRESHOLD_PCT) return Trend.rising
  if (change < TREND_FALLING_THRESHOLD_PCT) return Trend.falling
  return Trend.stable
}

/**
 * Clamp a tip from below by the previously-published tip, decayed at
 * `decayCap` per block of elapsed time. Upside is unclamped (a real
 * spike propagates immediately).
 *
 * `decayCap` is expressed wad: `parseEther('0.125')` is 12.5% (EIP-1559
 * parity). `null` disables capping entirely — every cycle publishes the
 * raw tip with no anchor. `0n` means no decay allowed (last published
 * is the floor in perpetuity until upside breaks it). `WAD` (1e18)
 * means full collapse permitted after one block (effectively no floor).
 *
 * Pure integer math:
 *   retention factor per block = (WAD - decayCap) / WAD
 *   floor = lastPublished * retention^nBlocks
 *
 * Cold start (no history) returns `rawTip` verbatim. Same-block
 * duplicate polls hold the previous value (n ≤ 0 case).
 */
export const cappedTip = (
  rawTip: bigint,
  nowBlockNumber: bigint,
  lastPublished: bigint | undefined,
  lastPublishedBlockNumber: bigint | undefined,
  decayCap: bigint | null = DEFAULT_PRIORITY_FEE_DECAY_CAP,
): bigint => {
  if (decayCap === null) return rawTip
  if (lastPublished === undefined || lastPublishedBlockNumber === undefined) {
    return rawTip
  }
  const nBlocks = nowBlockNumber - lastPublishedBlockNumber
  if (nBlocks <= 0n) {
    return rawTip > lastPublished ? rawTip : lastPublished
  }
  const retain = WAD - decayCap
  let factor = WAD
  for (let i = 0n; i < nBlocks; i += 1n) {
    factor = (factor * retain) / WAD
  }
  const downsideFloor = (lastPublished * factor) / WAD
  return rawTip > downsideFloor ? rawTip : downsideFloor
}

/**
 * Tier → percentile target, in the [0, 100] integer space used by
 * `gasWeightedPercentiles`. `standard` is p50 (the median) so the
 * recommended tip lands inside the paying lane on bimodal chains rather
 * than chasing the spam lane at p25.
 */
const TIER_PERCENTILE: Array<[TierName, number]> = [
  [TierName.slow, 10],
  [TierName.standard, 50],
  [TierName.fast, 75],
  [TierName.instant, 90],
]

/**
 * Gas-weighted percentile of a tip distribution. Each sample is one
 * tx's effective tip + its declared gas; gas is the weight. Sort by tip
 * ascending, walk cumulative gas, return the tip of the first sample
 * whose running gas crosses `totalGas * p / 100`.
 *
 * Why gas-weight rather than count-weight? A 21k-gas spam tx and a
 * 2M-gas swap exert very different pressure on validator inclusion
 * choices; treating them as one count each understates the paying
 * lane's share. The unit miners actually maximize is total tip * gas,
 * so the gas-weighted distribution is the one our tier recommendations
 * should reflect.
 *
 * Edge cases:
 *   - Empty samples: every requested percentile returns 0n.
 *   - totalGas === 0n (only zero-gas samples): same as empty, every
 *     percentile is 0n.
 *   - Single sample: every percentile is that sample's tip.
 *
 * Bigint-only. No floating-point math; the gas target uses integer
 * division and is monotone in `p`.
 */
export const gasWeightedPercentiles = (
  samples: TipSample[],
  percentiles: number[],
): Record<number, bigint> => {
  const out: Record<number, bigint> = {}
  if (samples.length === 0) {
    for (const p of percentiles) out[p] = 0n
    return out
  }

  // Don't mutate the caller's array.
  const sorted = [...samples].sort((a, b) =>
    a.tip < b.tip ? -1 : a.tip > b.tip ? 1 : 0,
  )

  let totalGas = 0n
  for (const s of sorted) totalGas += s.gas

  if (totalGas === 0n) {
    for (const p of percentiles) out[p] = 0n
    return out
  }

  for (const p of percentiles) {
    const target = (totalGas * BigInt(p)) / 100n
    let cumulative = 0n
    let chosen = sorted[sorted.length - 1].tip
    for (const s of sorted) {
      cumulative += s.gas
      if (cumulative >= target) {
        chosen = s.tip
        break
      }
    }
    out[p] = chosen
  }
  return out
}

/** Default liveness window — one block ahead, matching pre-v0.2 behavior. */
export const DEFAULT_BASE_FEE_LIVENESS_BLOCKS = 1

/**
 * Buffer multiplier applied to base fee when computing `maxFeePerGas`.
 *
 * EIP-1559 lets base fee change by up to ±12.5% per block, so the
 * worst-case upper-bound trajectory over `N` blocks is `(9/8)^N`.
 * Callers who want their published recommendation to remain includable
 * for longer than one block (e.g. wallets sending into a UI where the
 * user might take 60+ seconds to confirm) raise `livenessBlocks` to
 * compound headroom proportionally.
 *
 * - Rising markets:  `(9/8)^N * 10/9` — adds an 11% extra margin on
 *                    top of the worst-case rise (preserves the old
 *                    1.25:1.125 ratio at N=1).
 * - Stable markets:  `(9/8)^N` — exact worst-case EIP-1559 trajectory.
 * - Falling markets: `1×` regardless of N. Base fee will continue to
 *                    drop, headroom is wasted.
 *
 * At `N=1` this matches the pre-v0.2 hardcoded values (1.25 / 1.125 / 1).
 */
const baseFeeBufferMultiplier = (
  trend: Trend,
  livenessBlocks: number,
): { num: bigint; den: bigint } => {
  if (trend === Trend.falling) return { num: 1n, den: 1n }

  let num = 1n
  let den = 1n
  for (let i = 0; i < livenessBlocks; i += 1) {
    num *= 9n
    den *= 8n
  }
  if (trend === Trend.rising) {
    num *= 10n
    den *= 9n
  }
  return { num, den }
}

/**
 * `priorityModel` cutoff: which tx types count as "paying lane."
 *
 * A sample is in the paying lane iff its `txType >= TxType.eip1559`
 * (≥ 2). Samples without a captured `txType` are excluded from the
 * paying-lane filter — better to under-count than to mis-bucket a
 * legacy tx into the priority lane and pull the recommendation up.
 */
const isPayingLaneSample = (sample: TipSample): boolean =>
  sample.txType !== undefined && sample.txType >= TxType.eip1559

/**
 * Concatenate ring + mempool samples into one gas-weighted distribution
 * and read the four tier percentiles from it. Each tier's raw tip is
 * then clamped from below by the dynamic decay cap (`cappedTip`) so a
 * single quiet block can't drop the published number off a cliff.
 *
 * Why one merged distribution rather than `max(blockTier, mempoolTier)`?
 * The competitive environment a customer's tx has to clear is the
 * union of paying-lane txs that just landed and paying-lane txs queued
 * for the next block. Taking percentiles from each source separately
 * and `max()`-ing them double-counts spam-lane bias on whichever side
 * happens to have less gas-weight in the paying lane on a given tick;
 * gas-weighting the union resolves that without per-source magic.
 *
 * `priorityModel: 'eip1559'` further filters the paying-lane tiers
 * (standard/fast/instant) down to type-2+ samples so legacy spam can't
 * suppress the recommendation on chains that honor the 1559 cutoff.
 * `slow` keeps drawing from the full union — it's the lane legacy txs
 * actually live in, and excluding them would mis-report it.
 *
 * `maxFeePerGas` = bufferedBaseFee + cappedTip. `gasPrice` (legacy
 * fallback) = baseFee + cappedTip. `maxFeePerBlobGas` is null when the
 * chain doesn't expose `excessBlobGas`.
 *
 * Returns the tier objects (for the published snapshot) and the
 * cappedTip values keyed by tier name (for the producer to persist as
 * `lastPublishedTips` for the next cycle's cap anchor).
 */
export const computeTiers = (input: {
  ringSamples: TipSample[]
  mempoolSamples: TipSample[]
  baseFee: bigint
  baseFeeTrend: Trend
  blob: { blobBaseFee: bigint; trend: Trend } | null
  blockNumber: bigint
  lastPublishedTips: Record<TierName, bigint> | undefined
  lastPublishedBlockNumber: bigint | undefined
  priorityFeeDecayCap?: bigint | null
  priorityModel?: PriorityModel
  baseFeeLivenessBlocks?: number
}): {
  tiers: Record<TierName, TierRecommendation>
  publishedTips: Record<TierName, bigint>
} => {
  const livenessBlocks =
    input.baseFeeLivenessBlocks ?? DEFAULT_BASE_FEE_LIVENESS_BLOCKS
  const { num: baseNum, den: baseDen } = baseFeeBufferMultiplier(
    input.baseFeeTrend,
    livenessBlocks,
  )
  const bufferedBase = (input.baseFee * baseNum) / baseDen

  const blobFee = (() => {
    if (!input.blob) return null
    const { num, den } = baseFeeBufferMultiplier(input.blob.trend, livenessBlocks)
    return (input.blob.blobBaseFee * num) / den
  })()

  const decayCap =
    input.priorityFeeDecayCap === undefined
      ? DEFAULT_PRIORITY_FEE_DECAY_CAP
      : input.priorityFeeDecayCap
  const priorityModel: PriorityModel = input.priorityModel ?? PriorityModel.eip1559

  const combined = [...input.ringSamples, ...input.mempoolSamples]
  const targets = TIER_PERCENTILE.map(([, p]) => p)

  // Full-distribution percentiles always exist — `slow` reads from them
  // regardless of model, so legacy txs find their lane.
  const fullPercentiles = gasWeightedPercentiles(combined, targets)

  // Paying-lane percentiles only computed when the model demands them;
  // saves one pass on the much-more-common 'flat' path.
  const payingLanePercentiles =
    priorityModel === PriorityModel.eip1559
      ? gasWeightedPercentiles(combined.filter(isPayingLaneSample), targets)
      : null

  const tiers = {} as Record<TierName, TierRecommendation>
  const publishedTips = {} as Record<TierName, bigint>

  for (const [name, percentileTarget] of TIER_PERCENTILE) {
    const useFiltered = payingLanePercentiles !== null && name !== TierName.slow
    const source = useFiltered ? payingLanePercentiles : fullPercentiles
    const rawTip = source[percentileTarget]
    const tip = cappedTip(
      rawTip,
      input.blockNumber,
      input.lastPublishedTips?.[name],
      input.lastPublishedBlockNumber,
      decayCap,
    )
    publishedTips[name] = tip
    tiers[name] = {
      maxPriorityFeePerGas: tip,
      maxFeePerGas: bufferedBase + tip,
      gasPrice: input.baseFee + tip,
      maxFeePerBlobGas: blobFee,
    }
  }

  return { tiers, publishedTips }
}

/**
 * EIP-4844 blob base fee from `excessBlobGas`. Implements the
 * fake_exponential approximation: `output = factor * e^(num/den)` via
 * iterative summation until the term goes to zero. Integer-only.
 *
 *   MIN_BLOB_BASE_FEE = 1
 *   BLOB_BASE_FEE_UPDATE_FRACTION = 3338477
 */
export const computeBlobBaseFee = (excessBlobGas: bigint): bigint => {
  const BLOB_BASE_FEE_UPDATE_FRACTION = 3338477n
  if (excessBlobGas === 0n) return 1n
  let output = 0n
  let accum = BLOB_BASE_FEE_UPDATE_FRACTION
  let i = 1n
  while (accum > 0n) {
    output += accum
    accum = (accum * excessBlobGas) / (BLOB_BASE_FEE_UPDATE_FRACTION * i)
    i += 1n
  }
  return output / BLOB_BASE_FEE_UPDATE_FRACTION
}

/**
 * Geth/Reth `txpool_content` returns `pending` and `queued`, each keyed
 * by sender → nonce → tx. This flattens to a tx array; queued is
 * usually ignored for tip math (those txs aren't competing for the
 * next block).
 */
export const flattenTxPool = (
  pool: Record<string, Record<string, RawTx>> | undefined | null,
): RawTx[] => {
  if (!pool) return []
  const txs: RawTx[] = []
  for (const byNonce of Object.values(pool)) {
    for (const tx of Object.values(byNonce)) txs.push(tx)
  }
  return txs
}
