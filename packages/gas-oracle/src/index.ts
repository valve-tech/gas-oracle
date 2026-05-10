/**
 * @valve-tech/gas-oracle — public API.
 *
 * Multi-tier gas-fee oracle for EVM chains. Pass it a viem PublicClient
 * and it polls block + mempool data, computes slow/standard/fast/instant
 * tier recommendations, and exposes them via a sub-millisecond in-memory
 * read. Includes EIP-1559-style 12.5%/block downside cap so quiet blocks
 * don't drop the published number off a cliff, and EIP-4844 blob fee
 * for chains that support it.
 *
 * Zero runtime dependencies. viem is the only peer dependency, used to
 * issue the underlying RPC calls (`eth_feeHistory`,
 * `eth_getBlockByNumber`, `txpool_content`).
 */

export {
  createGasOracle,
  reducePollInputs,
  sampleGasFees,
  type CreateGasOracleOptions,
  type GasOracle,
} from './oracle.js'

export {
  effectiveTip,
  computePercentiles,
  detectTrend,
  cappedTip,
  computeTiers,
  computeBlobBaseFee,
  flattenTxPool,
  gasWeightedPercentiles,
  sortedTips,
  DEFAULT_PRIORITY_FEE_DECAY_CAP,
  DEFAULT_BASE_FEE_LIVENESS_BLOCKS,
} from './math.js'

export {
  blockToSample,
  mempoolToSamples,
} from './samples.js'

export {
  fetchOracleInputs,
  fetchHeadBlockNumber,
  type OraclePollInputs,
} from './transport.js'

export type {
  TipPercentiles,
  TierRecommendation,
  MempoolStats,
  BlobStats,
  BlockSample,
  GasOracleState,
  TipSample,
} from './types.js'

// Const-namespace pairs (value + type share the identifier — see types.ts).
export { PriorityModel, TierName, TIER_LADDER, Trend, TxType } from './types.js'

// Mempool inspection
export {
  normalizeMempool,
  findByHash,
  findByAddressNonce,
  findInMempool,
} from './mempool.js'
export type {
  TxIdentifier,
  MempoolBucket,
  MempoolHit,
} from './mempool.js'

/**
 * Wire-shape types describing raw `eth_*` responses, plus the poll-cycle
 * toggle. Owned by `@valve-tech/chain-source`; re-exported here so
 * downstream consumers don't have to add a second package import to
 * type a fixture or a stored snapshot.
 */
export type {
  BlockResult,
  FeeHistoryResult,
  NormalizedMempool,
  PollOptions,
  RawTx,
  TxPoolContent,
} from '@valve-tech/chain-source'

// Block-position calculations
export { tipForBlockPosition } from './block-position.js'
export type {
  BlockPositionQuery,
  BlockPositionResult,
} from './block-position.js'

// Replacement helpers (same-nonce EIP-1559)
export {
  minimumReplacementFee,
  bumpForReplacement,
  recommendBumpTier,
  BumpStrategy,
  ReplacementBumpPercent,
} from './replacement.js'
export type {
  RecommendBumpTierOptions,
  ReplacementGas,
} from './replacement.js'

// Tip classification (inverse of tipForBlockPosition)
export { classifyTip, type ClassifyTipResult } from './classify-tip.js'

// Inclusion labels (UI copy with optional locale overrides)
export { defaultInclusionLabels, inclusionLabel } from './inclusion-labels.js'

// Chain presets (per-chain config overrides for createGasOracle)
export {
  chainPresets,
  presetForChainId,
  type ChainPreset,
} from './presets.js'
