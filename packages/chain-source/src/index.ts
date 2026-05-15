/**
 * `@valve-tech/chain-source` — canonical EVM chain-observation primitive
 * for the `valve-tech/evm-toolkit` synchronized release line.
 *
 * The package is the *foundation* layer for every derived view of
 * chain state in the toolkit. Both `@valve-tech/gas-oracle` (gas-tier
 * reducer) and `@valve-tech/tx-tracker` (per-tx state machine) consume
 * a `ChainSource` rather than re-implementing their own poll cycles.
 * One upstream RPC stream feeds every consumer that attaches.
 *
 * See `docs/tx-tracker-spec.md` §3 for the full design contract.
 *
 * @example
 *   import { createPublicClient, http } from 'viem'
 *   import { mainnet } from 'viem/chains'
 *   import { createChainSource } from '@valve-tech/chain-source'
 *
 *   const client = createPublicClient({ chain: mainnet, transport: http() })
 *   const source = createChainSource({ client })
 *
 *   source.subscribeBlocks((block) => {
 *     console.log('block', block.number)
 *   })
 *   source.start()
 */

export { createChainSource } from './source.js'
export type {
  AdaptivePollOptions,
  ChainSource,
  CreateChainSourceOptions,
  Logger,
} from './source.js'

export { Subscriptions } from './subscriptions.js'

export { normalizeMempool } from './mempool.js'

export { probeCapabilities } from './capabilities.js'

export {
  safeRequest,
  estimateBlockTimeMs,
  fetchBlock,
  fetchBlockByHash,
  fetchHeadBlockNumber,
  fetchFeeHistory,
  fetchTxPool,
  fetchReceipt,
  fetchTransaction,
  zeroHash,
} from './transport.js'

export type {
  BlockResult,
  Capabilities,
  EventSource,
  FeeHistoryResult,
  NormalizedMempool,
  PollOptions,
  RawTx,
  TransactionReceipt,
  TxPoolContent,
} from './types.js'
