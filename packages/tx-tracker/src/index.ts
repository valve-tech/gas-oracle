/**
 * `@valve-tech/tx-tracker` — per-tx state machine for EVM chains.
 *
 * Emits **neutral observations** (`seen-in-mempool`, `seen-in-block`,
 * `replaced-by`, `vanished-from-block`, `unseen-for-N-blocks`,
 * `signal-degraded`, `signal-recovered`, `stopped`) so wallet UIs,
 * indexers, and relays can write their own interpretations on top.
 * The tracker itself never says "confirmed" or "stuck"; it gives
 * you the data to decide.
 *
 * Three consumption shapes (callback, async iterator, snapshot)
 * over one push-based core. Per-method capability detection keeps
 * the "no silent downgrade" invariant — every emitted event carries
 * a `source` discriminator (`'subscription' | 'block-poll' |
 * 'mempool-snapshot' | 'receipt-poll'`).
 *
 * Consumes `@valve-tech/chain-source` for upstream signals; sibling
 * to `@valve-tech/gas-oracle` (both consume the same source, neither
 * depends on the other).
 *
 * @example
 *   import { createPublicClient, http } from 'viem'
 *   import { mainnet } from 'viem/chains'
 *   import { createChainSource } from '@valve-tech/chain-source'
 *   import { createTxTracker } from '@valve-tech/tx-tracker'
 *
 *   const client  = createPublicClient({ chain: mainnet, transport: http() })
 *   const source  = createChainSource({ client })
 *   const tracker = createTxTracker({ source, chainId: 1 })
 *
 *   source.start()
 *   tracker.start()
 *
 *   for await (const event of tracker.track('0xabc...')) {
 *     console.log(event.kind, event.source, event.at.blockNumber)
 *     if (event.kind === 'seen-in-block' && event.confirmations >= 6) break
 *   }
 *
 *   tracker.stop()
 *   source.stop()
 */

export { createTxTracker } from './tracker.js'
export type {
  CreateTxTrackerOptions,
  TxTracker,
  TrackOptions,
  BulkTrackOptions,
  TxMatchEvent,
  TxSubscription,
  LostSignalPolicy,
  GroupOptions,
  TxGroupSubscription,
} from './tracker.js'

export {
  buildStarted,
  buildSeenInMempool,
  buildLeftMempool,
  buildSeenInBlock,
  buildVanishedFromBlock,
  buildReplacedBy,
  buildUnseenForNBlocks,
  buildSignalDegraded,
  buildSignalRecovered,
  buildStopped,
  buildInitialStatus,
} from './events.js'
export type {
  Address,
  At,
  Envelope,
  Hash,
  TxEvent,
  TxEventStarted,
  TxEventSeenInMempool,
  TxEventLeftMempool,
  TxEventSeenInBlock,
  TxEventVanishedFromBlock,
  TxEventReplacedBy,
  TxEventUnseenForNBlocks,
  TxEventSignalDegraded,
  TxEventSignalRecovered,
  TxEventStopped,
  TxStatus,
} from './events.js'

export {
  createInMemoryStore,
  computeRetentionExpiry,
  defaultRetentionBlocks,
} from './store.js'
export type {
  BulkSelector,
  HashSelector,
  InMemoryStoreOptions,
  PersistedSubscription,
  TrackedTxRecord,
  TxTrackerStore,
} from './store.js'

export {
  appendBlock,
  defaultReorgDepthBlocks,
  detectDivergences,
} from './reorg.js'
export type { BlockDivergence, BlockSample } from './reorg.js'

export {
  compileSelector,
  defaultMaxBulkSubscriptions,
  matchAll,
} from './selectors.js'
export type { BulkMatchPayload, CompiledSelector } from './selectors.js'

export { createTxGroup } from './group.js'

export { watchTransaction } from './watch-transaction.js'
export type { WatchTransactionOptions } from './watch-transaction.js'

export {
  buildGroupComplete,
  buildGroupFailed,
  buildGroupProgress,
  buildGroupStopped,
} from './group-events.js'
export type {
  TxGroupEvent,
  TxGroupEventComplete,
  TxGroupEventEnvelope,
  TxGroupEventFailed,
  TxGroupEventProgress,
  TxGroupEventStopped,
} from './group-events.js'
