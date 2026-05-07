/**
 * Shared types for the gas oracle. Pure data shapes — no deps.
 *
 * Wire format note: every fee field is a `bigint`. Callers serializing
 * across HTTP / Redis / WebSocket should hex-encode (`'0x' + n.toString(16)`)
 * since JSON has no native bigint and `JSON.stringify` will throw on raw
 * bigint values. The caller owns that encoding — this package keeps the
 * canonical numeric form internally.
 */

/**
 * Minimal tx shape extracted from `eth_getBlockByNumber(latest, true)` or
 * `txpool_content`. Fee fields drive tip math; `hash`, `from`, `nonce`
 * support mempool lookups (`findByHash` / `findByAddressNonce`). Other
 * tx fields (to/value/data/etc.) are ignored.
 *
 * `hash`, `from`, `nonce` are nominally optional because `eth_get-
 * BlockByNumber(_, true)` blocks always carry them but we want callers
 * to be able to construct `RawTx` from minimal fixtures in tests.
 * geth/reth `txpool_content` includes all three.
 */
export interface RawTx {
  maxPriorityFeePerGas?: string
  maxFeePerGas?: string
  gasPrice?: string
  gas?: string
  type?: string
  hash?: string
  from?: string
  nonce?: string
}

export interface TipPercentiles {
  p10: bigint
  p25: bigint
  p50: bigint
  p75: bigint
  p90: bigint
}

/**
 * One fee-tier recommendation. `gasPrice` is included for legacy callers
 * (type-0/1 txs) and is computed as `baseFee + maxPriorityFeePerGas`.
 * `maxFeePerBlobGas` is null on chains without EIP-4844 support.
 */
export interface TierRecommendation {
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  gasPrice: bigint
  maxFeePerBlobGas: bigint | null
}

export const Trend = {
  rising: 'rising',
  falling: 'falling',
  stable: 'stable',
} as const
export type Trend = (typeof Trend)[keyof typeof Trend]

export const TierName = {
  slow: 'slow',
  standard: 'standard',
  fast: 'fast',
  instant: 'instant',
} as const
export type TierName = (typeof TierName)[keyof typeof TierName]

/**
 * Canonical tier ordering, slow → instant. Used by helpers that walk the
 * tier ladder (e.g., `classifyTip` finds the highest tier whose floor a
 * tip clears; `recommendBumpTier` finds the cheapest tier that clears
 * the protocol floor + outpace floor). Ordering is load-bearing.
 */
export const TIER_LADDER: readonly TierName[] = [
  TierName.slow,
  TierName.standard,
  TierName.fast,
  TierName.instant,
] as const

export interface MempoolStats {
  pendingCount: bigint
  queuedCount: bigint
  /** Sum of `tx.gas` across all pending txs — congestion proxy. */
  pendingGasDemand: bigint
  /** Latest block's gas limit, useful for "pending demand vs. block capacity". */
  blockGasLimit: bigint
}

export interface BlobStats {
  blobBaseFee: bigint
  excessBlobGas: bigint
  blobGasUsed: bigint
  blobBaseFeeTrend: Trend
}

/**
 * One per-tx contribution to the priority-fee distribution.
 *
 * - `tip`     — effective per-gas tip miners maximize for inclusion.
 * - `gas`     — declared gas; the gas-weighting denominator for percentile math.
 * - `txType`  — EIP-2718 type byte (0 legacy, 1 EIP-2930, 2 EIP-1559, 3
 *               EIP-4844, 4 EIP-7702, …). Used by `priorityModel: 'eip1559'`
 *               filtering to keep paying-lane tiers honest on chains that
 *               honor the cutoff.
 * - `hash`    — the tx hash, for `tipForBlockPosition({ kind: 'aheadOf' })`-
 *               style relative targeting. Optional because tests construct
 *               minimal samples by hand.
 * - `address` — sender address, lowercased. Pairs with `nonce` to identify
 *               a tx without needing its hash.
 * - `nonce`   — decimal-string normalized.
 */
export interface TipSample {
  tip: bigint
  gas: bigint
  txType?: number
  hash?: string
  address?: string
  nonce?: string
}

/**
 * Where the chain's inclusion logic draws its priority cutoff in the
 * tx-type space.
 *
 * - `'flat'`     — chain ignores the EIP-2718 type byte for ordering.
 *                  Tiers derive from a single gas-weighted distribution
 *                  across all txs. Right for extractive validators
 *                  (PulseChain et al.) where the only signal that matters
 *                  is fee per gas, regardless of tx envelope.
 * - `'eip1559'`  — type 2+ txs get priority. Paying-lane tiers
 *                  (standard/fast/instant) derive from type-2+ samples
 *                  only; `slow` still draws from the full distribution
 *                  so legacy senders find their lane. Right for chains
 *                  that honor the 1559 fee-market shape.
 *
 * Future cutoffs can be added (e.g. `'eip4844'` for blob-only priority)
 * without re-interpreting existing values.
 */
export const PriorityModel = {
  flat: 'flat',
  eip1559: 'eip1559',
} as const
export type PriorityModel = (typeof PriorityModel)[keyof typeof PriorityModel]

/**
 * EIP-2718 transaction type bytes. Identifier values — never participate
 * in arithmetic, so they stay `number` per the package-wide bigint
 * carve-out.
 */
export const TxType = {
  legacy: 0,
  eip2930: 1,
  eip1559: 2,
  blob: 3,
  setCodeAuthorization: 4,
} as const
export type TxType = (typeof TxType)[keyof typeof TxType]

/**
 * Producer-side toggles: which RPCs the oracle calls upstream each cycle.
 *
 * Fields default to true. `eth_getBlockByNumber` is intentionally not
 * toggleable — without a block we can't compute anything.
 *
 * - `feeHistory: false` — drops `eth_feeHistory`. Trend detection falls
 *                          back to a single-element history (always
 *                          reports `'stable'`); percentile fallback
 *                          becomes block-only.
 * - `mempool: false`    — drops `txpool_content`. Tiers reflect block
 *                          inclusion only, not pending pressure. Useful
 *                          when the upstream provider gates the
 *                          method (many public RPCs return 405).
 */
export interface PollOptions {
  feeHistory?: boolean
  mempool?: boolean
}

/**
 * One block's worth of state retained in the rolling ring. Per-tx tips
 * + gas are kept so we can re-percentile on each poll without re-fetching
 * historical blocks. Header fields support the reorg/missed-poll detector
 * (see spec §7).
 */
export interface BlockSample {
  number: bigint
  hash: string
  parentHash: string
  baseFee: bigint
  gasUsed: bigint
  tips: TipSample[]
}

/**
 * Snapshot of a single chain's gas-oracle state. Re-published on every
 * poll cycle. `lastPublishedTips`, `lastPublishedBlockNumber`, and `ring`
 * are the producer-local cap anchor + sample buffer used by `cappedTip`
 * and tier construction; consumers receiving a serialized snapshot can
 * ignore them (the relay's `toPublishable` strips them before publish).
 */
export interface GasOracleState {
  chainId: number
  blockNumber: bigint
  timestamp: bigint
  baseFee: bigint
  baseFeeTrend: Trend
  baseFeeHistory: bigint[]
  mempool: MempoolStats
  blob: BlobStats | null
  tiers: Record<TierName, TierRecommendation>
  /**
   * Rolling ring of recent blocks (oldest → newest). Producer-only.
   * Currently always single-element; the 20-block lifecycle (append /
   * bridgeGap / clearAndBackfill) is deferred to a follow-up per spec
   * §7-§9.
   */
  ring: BlockSample[]
  /**
   * Live mempool samples used to compute this snapshot's tiers.
   * Producer-local — wire publishers should strip before serializing
   * (same convention as `ring`). Consumed by replacement / classification
   * helpers (e.g., `recommendBumpTier`'s outpace correction) for live-
   * distribution analysis without re-fetching mempool data. Each poll
   * replaces this field; no cumulative growth.
   */
  mempoolSamples: TipSample[]
  lastPublishedTips?: Record<TierName, bigint>
  lastPublishedBlockNumber?: bigint
}
