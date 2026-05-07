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
  type FeeHistoryResult,
  type BlockResult,
  type TxPoolContent,
  type OraclePollInputs,
} from './transport.js'

export type {
  RawTx,
  TipPercentiles,
  TierRecommendation,
  MempoolStats,
  BlobStats,
  BlockSample,
  GasOracleState,
  TipSample,
  PollOptions,
} from './types.js'

// Const-namespace pairs (value + type share the identifier — see types.ts).
export { PriorityModel, TierName, Trend, TxType } from './types.js'

// Mempool inspection
export {
  normalizeMempool,
  findByHash,
  findByAddressNonce,
  findInMempool,
} from './mempool.js'
export type {
  NormalizedMempool,
  TxIdentifier,
  MempoolBucket,
  MempoolHit,
} from './mempool.js'

// Block-position calculations
export { tipForBlockPosition } from './block-position.js'
export type {
  BlockPositionQuery,
  BlockPositionResult,
} from './block-position.js'
