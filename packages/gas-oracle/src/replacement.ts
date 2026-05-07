/**
 * Same-nonce EIP-1559 replacement helpers. Pure functions; no I/O.
 *
 * The protocol-replacement-floor math is verified against geth
 * `core/txpool/legacypool/list.go:Add()`, geth `core/txpool/blobpool/
 * config.go`, reth `crates/transaction-pool/src/config.rs`, and PulseChain
 * `gitlab.com/pulsechaincom/go-pulse/master/core/txpool/legacypool/
 * legacypool.go`. The `+1n` term in `minimumReplacementFee` is load-
 * bearing for small `current` values where geth's integer-floor threshold
 * collapses below the strict `old < tx` check.
 */

import { TIER_LADDER, TierName, TxType, type GasOracleState } from './types.js'
import type { TxIdentifier } from './mempool.js'
import { tipForBlockPosition } from './block-position.js'

export const ReplacementBumpPercent = {
  /** geth `legacypool.DefaultConfig.PriceBump` — legacy / EIP-2930 / EIP-1559 / EIP-7702. */
  default: 10n,
  /** geth `blobpool.DefaultConfig.PriceBump` — EIP-4844 blob txs. */
  blob: 100n,
} as const

/**
 * Minimum fee required to replace a tx at a given current fee. Per-field
 * primitive — apply once to `maxFeePerGas` and once to
 * `maxPriorityFeePerGas` for an EIP-1559 replacement.
 *
 * Returns `(current * (100 + bump)) / 100 + 1`, where `bump` is `100n`
 * for blob txs and `10n` otherwise. The `+1` clears geth's strict
 * `old < tx` check at small `current` values where the integer-floor
 * threshold collapses (e.g. `current=1`, `floor(1.1)=1`).
 *
 * Unknown future tx-type bytes default to the legacy/1559 +10% bump —
 * the +100% rule is blob-specific.
 */
export const minimumReplacementFee = (
  current: bigint,
  txType: number,
): bigint => {
  const bump =
    txType === TxType.blob
      ? ReplacementBumpPercent.blob
      : ReplacementBumpPercent.default
  return (current * (100n + bump)) / 100n + 1n
}

export interface ReplacementGas {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/**
 * Compute (maxFeePerGas, maxPriorityFeePerGas) for replacing a 1559 tx.
 * Per-field rule: max(target, protocolFloor). Final guard ensures
 * `result.maxFeePerGas >= result.maxPriorityFeePerGas` so the result is
 * a well-formed tx even on degenerate target inputs.
 *
 * 1559-scoped — for blob replacement use `minimumReplacementFee(_,
 * TxType.blob)` directly per fee field.
 */
export const bumpForReplacement = (
  currentGas: ReplacementGas,
  targetGas: ReplacementGas,
): ReplacementGas => {
  const maxFeeFloor = minimumReplacementFee(
    currentGas.maxFeePerGas,
    TxType.eip1559,
  )
  const priorityFloor = minimumReplacementFee(
    currentGas.maxPriorityFeePerGas,
    TxType.eip1559,
  )
  const maxPriorityFeePerGas =
    targetGas.maxPriorityFeePerGas > priorityFloor
      ? targetGas.maxPriorityFeePerGas
      : priorityFloor
  let maxFeePerGas =
    targetGas.maxFeePerGas > maxFeeFloor ? targetGas.maxFeePerGas : maxFeeFloor
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas
  return { maxFeePerGas, maxPriorityFeePerGas }
}

export const BumpStrategy = {
  cheapestThatLands: 'cheapestThatLands',
  oneStepFasterThanRecommended: 'oneStepFasterThanRecommended',
  instant: 'instant',
} as const
export type BumpStrategy = (typeof BumpStrategy)[keyof typeof BumpStrategy]

export interface RecommendBumpTierOptions {
  /** Default: `BumpStrategy.cheapestThatLands`. */
  strategy?: BumpStrategy
}

/**
 * Pick a tier to bump to for a same-nonce EIP-1559 replacement. The
 * effective floor is `max(protocolFloor, outpaceFloor)`:
 *   - protocolFloor = `minimumReplacementFee(stuckTx.priorityTip,
 *     TxType.eip1559)` — the geth +10% rule.
 *   - outpaceFloor = the tip required to be ranked strictly above every
 *     tx currently ahead of `stuckTx.identifier` in
 *     `snapshot.mempoolSamples`. Computed by locating stuck's rank via
 *     `tipForBlockPosition({ kind: 'aheadOf', tx: identifier })` then
 *     querying `{ kind: 'rank', rank: stuckRank - 1n }` to outbid the
 *     tx currently just above stuck. When stuck is already at the top
 *     of the distribution (or not present), this is `0n` and only the
 *     protocol floor applies.
 *
 * Returns `null` when no tier clears the effective floor — the original
 * was already paying above the top of the ladder, or the snapshot has
 * no tip data.
 */
export const recommendBumpTier = (
  snapshot: GasOracleState,
  stuckTx: { priorityTip: bigint; identifier?: TxIdentifier },
  options: RecommendBumpTierOptions = {},
): TierName | null => {
  const strategy = options.strategy ?? BumpStrategy.cheapestThatLands
  const protocolFloor = minimumReplacementFee(
    stuckTx.priorityTip,
    TxType.eip1559,
  )
  const outpaceFloor = stuckTx.identifier
    ? (() => {
        const stuckPosition = tipForBlockPosition(snapshot.mempoolSamples, {
          kind: 'aheadOf',
          tx: stuckTx.identifier,
        })
        // Stuck not in mempool, or stuck already at rank 0 (no one above).
        if (stuckPosition.pivot === null || stuckPosition.rank === 0n) return 0n
        // Outbid the tx at rank `stuckRank - 1` (the cheapest tx
        // currently ahead of stuck) — landing here is sufficient to
        // outpace every tx currently above stuck.
        return tipForBlockPosition(snapshot.mempoolSamples, {
          kind: 'rank',
          rank: stuckPosition.rank - 1n,
        }).requiredTip
      })()
    : 0n
  const floor = protocolFloor > outpaceFloor ? protocolFloor : outpaceFloor

  const cheapestIndex = TIER_LADDER.findIndex(
    (tier) => snapshot.tiers[tier].maxPriorityFeePerGas > floor,
  )
  if (cheapestIndex === -1) return null

  if (strategy === BumpStrategy.cheapestThatLands)
    return TIER_LADDER[cheapestIndex]
  if (strategy === BumpStrategy.instant) return TierName.instant
  // oneStepFasterThanRecommended
  return TIER_LADDER[Math.min(cheapestIndex + 1, TIER_LADDER.length - 1)]
}
