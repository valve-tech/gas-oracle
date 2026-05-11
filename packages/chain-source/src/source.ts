/**
 * `createChainSource` — the canonical chain-observation primitive
 * for `@valve-tech/evm-toolkit`. Owns:
 *
 *   - the upstream poll cycle (block + mempool fan-out per tick)
 *   - the per-method capability probe (run eagerly at construction)
 *   - typed pub/sub for blocks and mempool snapshots, with
 *     multiple-subscribers-per-stream as a first-class guarantee
 *   - on-demand RPC passthroughs for individual blocks, fee history,
 *     receipts, and transactions
 *
 * Sibling features (`@valve-tech/gas-oracle`, `@valve-tech/tx-tracker`)
 * consume `ChainSource` and never re-implement the poll loop. One
 * upstream RPC cycle, regardless of how many derived views attach.
 *
 * Lifecycle (per spec §14.1):
 *
 *   - `start()` begins interval-driven polling. Idempotent.
 *   - `stop()` halts the interval; subscriber registry is preserved
 *     so a `start() → stop() → start()` resume keeps existing
 *     subscriptions alive.
 *   - The capability probe runs eagerly at *construction*, not at
 *     start(). By the time a consumer calls `capabilities()` after
 *     any await, the probe has typically landed. For a brief window
 *     immediately after `createChainSource()`, `capabilities()` returns
 *     a conservative default (everything `unavailable` / `gated`).
 *     Callers that need a guaranteed-fresh result can `await
 *     source.ready()` before reading `capabilities()`.
 *
 * Push subscriptions (eth_subscribe):
 *
 *   - As of v0.8.0, when capabilities.newHeads === 'subscription' (probed at
 *     construction via probeCapabilities), the source opens a live
 *     eth_subscribe('newHeads') lazily on the first start(). Head events
 *     are piped through the existing fetchBlock + dedup-by-hash machinery
 *     so push and poll coexist safely. On subscribe failure, the cached
 *     capability downgrades to 'poll-only', surfaces via onError, and the
 *     poll cycle continues unchanged.
 *   - When capabilities.newPendingTransactions === 'subscription', the source
 *     opens a live eth_subscribe('newPendingTransactions') lazily on the first
 *     start(). Push notifications carry a hash only — the source fetches the
 *     full tx via eth_getTransactionByHash and emits a single-tx
 *     NormalizedMempool snapshot. On subscribe failure, the cached capability
 *     downgrades to poll-only (or unavailable when txpool_content is also
 *     gated). Push and poll coexist — mempool snapshots are intentionally
 *     not deduped (txs come and go between blocks even on a static head).
 */

import type { PublicClient } from 'viem'

import { probeCapabilities } from './capabilities.js'
import { normalizeMempool } from './mempool.js'
import { Subscriptions } from './subscriptions.js'
import {
  fetchBlock,
  fetchBlockByHash,
  fetchFeeHistory,
  fetchHeadBlockNumber,
  fetchReceipt,
  fetchTransaction,
  fetchTxPool,
} from './transport.js'
import type {
  BlockResult,
  Capabilities,
  FeeHistoryResult,
  NormalizedMempool,
  PollOptions,
  RawTx,
  TransactionReceipt,
} from './types.js'

const DEFAULT_POLL_INTERVAL_MS = 10_000

/**
 * Conservative capability default returned by `capabilities()` before
 * the eager probe completes. Every signal is treated as unavailable
 * until proven otherwise — consumers reading capabilities in this
 * window get the safest answer (no path is available, fall back to
 * the most defensive flow). Once the probe lands, real values
 * overwrite this.
 */
const PROBING_DEFAULT: Capabilities = {
  newHeads: 'unavailable',
  newPendingTransactions: 'unavailable',
  txpoolContent: 'gated',
  receiptByHash: 'unavailable',
  reprobeOnReconnect: false,
}

export interface CreateChainSourceOptions {
  /** viem PublicClient pointed at the upstream RPC. */
  client: PublicClient
  /**
   * Polling interval in ms when push subscriptions aren't available
   * (or aren't preferred). Default 10_000.
   */
  pollIntervalMs?: number
  /**
   * Producer-side toggles: which RPCs the source's tick fans out.
   * Disabling `mempool` here disables `subscribeMempool` for every
   * consumer; the source-level toggle is the single source of truth.
   * `feeHistory` is currently informational — the source's tick does
   * not fan out fee history; consumers fetch it on demand via
   * `getFeeHistory`. The toggle is reserved for forward-compatibility.
   */
  poll?: PollOptions
  /**
   * Optional error sink — called per-method when an RPC fails. Same
   * role as on `createGasOracle`. Failures are otherwise swallowed
   * (the source keeps running on partial data).
   */
  onError?: (method: string, err: unknown) => void
}

export interface ChainSource {
  /** Begin the poll loop. Idempotent. */
  start: () => void
  /** Halt the poll loop. Subscribers preserved across stop/start. Idempotent. */
  stop: () => void
  /**
   * Run one poll cycle out-of-band. Useful for tests, manual
   * refreshes, and serverless contexts where the interval timer
   * isn't appropriate. Fans out to subscribers identically to a
   * timer-driven tick.
   *
   * Additive over the design contract — the spec exposes only
   * subscribe + on-demand methods, but pollOnce is a natural
   * symmetric helper that keeps the test surface honest without
   * depending on fake timers.
   */
  pollOnce: () => Promise<void>
  /**
   * Resolve when the eager capability probe (kicked off at
   * construction) has completed. After this resolves, `capabilities()`
   * returns the real probed values rather than the conservative
   * default.
   */
  ready: () => Promise<void>
  /** Subscribe to new-block events. Multiple subscribers allowed. */
  subscribeBlocks: (cb: (block: BlockResult) => void) => () => void
  /** Subscribe to mempool snapshots. Multiple subscribers allowed. */
  subscribeMempool: (cb: (snapshot: NormalizedMempool) => void) => () => void
  /** On-demand: fetch a single block (full transactions). */
  getBlock: (tag: 'latest' | bigint) => Promise<BlockResult | null>
  /**
   * On-demand: fetch a block by its hash (full transactions). Used by
   * consumers that need to walk a reorged-away branch — `getBlock`
   * by number returns whatever block is now canonical at that height,
   * which is the wrong answer when the goal is "the block that was
   * once at this hash." Returns `null` on transport error or if the
   * upstream no longer carries the hash (deep reorg, pruned archive).
   */
  getBlockByHash: (hash: string) => Promise<BlockResult | null>
  /** On-demand: fee history. */
  getFeeHistory: (
    blockCount: number,
    percentiles: number[],
  ) => Promise<FeeHistoryResult | null>
  /**
   * On-demand: fresh `txpool_content` snapshot, normalized. Returns
   * `null` when the upstream gates the method. For continuous access,
   * prefer `subscribeMempool` — that path reuses the source's poll
   * cycle and avoids a fresh RPC per call.
   */
  getMempoolSnapshot: () => Promise<NormalizedMempool | null>
  /** On-demand: receipt by tx hash. */
  getReceipt: (hash: string) => Promise<TransactionReceipt | null>
  /** On-demand: tx by hash (used by tx-tracker for replacement detection). */
  getTransaction: (hash: string) => Promise<RawTx | null>
  /** Latest probed capability snapshot. */
  capabilities: () => Capabilities
}

/**
 * Build a configured chain-source. The eager capability probe starts
 * immediately; nothing else happens until `start()` is called.
 *
 * @example
 *   import { createPublicClient, http } from 'viem'
 *   import { mainnet } from 'viem/chains'
 *   import { createChainSource } from '@valve-tech/chain-source'
 *
 *   const client = createPublicClient({ chain: mainnet, transport: http() })
 *   const source = createChainSource({ client })
 *
 *   source.subscribeBlocks((block) => console.log('new block', block.number))
 *   source.start()
 *
 *   // ... later
 *   source.stop()
 */
export const createChainSource = (
  options: CreateChainSourceOptions,
): ChainSource => {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const fetchMempool = options.poll?.mempool !== false

  const blockSubs = new Subscriptions<BlockResult>()
  const mempoolSubs = new Subscriptions<NormalizedMempool>()

  let timer: ReturnType<typeof setInterval> | null = null
  let started = false
  let cachedCapabilities: Capabilities = PROBING_DEFAULT
  /**
   * Narrow the viem transport to its WebSocket-specific `subscribe` shape once.
   * viem's `Transport` type does not model this method; we structurally narrow
   * through `unknown` here and reuse the result in both `tryOpen*Subscription`
   * functions rather than redeclaring the cast in each.
   */
  const wsTransport = options.client.transport as unknown as {
    subscribe: (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }) => Promise<{ unsubscribe: () => void }>
  }

  let blockSubscriptionHandle: { unsubscribe: () => void } | null = null
  let mempoolSubscriptionHandle: { unsubscribe: () => void } | null = null
  // Dedup key for the block stream — by hash, not number, so that a
  // same-height reorg (different hash, same number) still surfaces as
  // a fresh observation. Reset on stop() so a paused-then-resumed
  // source emits a current snapshot to its consumers rather than
  // waiting for the next chain block. Typed `string | undefined` to
  // match `BlockResult.hash`'s optionality (real upstream blocks
  // always carry a hash; the type stays permissive for test fixtures).
  let lastEmittedBlockHash: string | undefined
  // Head-probe gate state — last `eth_blockNumber`-confirmed head we
  // actually fetched a full block for. Lets the tick skip
  // `eth_getBlockByNumber('latest', true)` (1–5MB on busy chains)
  // when the head hasn't moved. Same lifecycle as the dedup hash —
  // reset on stop() so a paused-then-resumed source defensively
  // re-fetches even at the same height.
  let lastSeenBlockNumber: bigint | undefined

  const errSink = (method: string) =>
    options.onError ? (err: unknown) => options.onError!(method, err) : undefined

  /**
   * Fetch the full block at 'latest' and pipe it through the existing
   * dedup machinery. Called from the WS `newHeads` subscription's
   * `onData` handler whenever a head notification arrives.
   */
  const handleHeadNotification = async (): Promise<void> => {
    const block = await fetchBlock(
      options.client,
      'latest',
      errSink('eth_getBlockByNumber'),
    )
    if (!block) return
    if (block.hash !== lastEmittedBlockHash) {
      lastEmittedBlockHash = block.hash
      try {
        lastSeenBlockNumber = BigInt(block.number)
      } catch {
        // Unparseable block number — leave gate state untouched so the
        // next poll tick re-fetches rather than skipping on garbage state.
      }
      blockSubs.emit(block)
    }
  }

  /**
   * Open one `eth_subscribe('newHeads')` lazily — called once the probe
   * has resolved and confirmed `newHeads === 'subscription'`. Head
   * notifications are piped through `handleHeadNotification` + the
   * existing dedup machinery so push and poll coexist safely. Failure
   * downgrades the cached capability to `'poll-only'` and surfaces via
   * `onError`; the existing poll cycle continues unchanged.
   *
   * No idempotency flag is needed here: start() is already gated by the
   * outer `started` flag (preventing double-subscription within one start
   * cycle), and stop()/start() resume legitimately requires this function
   * to run again — stop() sets blockSubscriptionHandle = null so the next
   * call opens a fresh subscription cleanly.
   */
  const tryOpenBlockSubscription = async (): Promise<void> => {
    if (cachedCapabilities.newHeads !== 'subscription') return
    try {
      blockSubscriptionHandle = await wsTransport.subscribe({
        params: ['newHeads'],
        // Head notifications: fetch the full block at the tip and emit
        // through the existing dedup machinery. Hash dedup in blockSubs
        // already handles WS-vs-poll race and same-height reorgs.
        onData: () => void handleHeadNotification(),
        onError: (err) => options.onError?.('eth_subscribe.newHeads', err),
      })
    } catch (err) {
      options.onError?.('eth_subscribe.newHeads', err)
      cachedCapabilities = { ...cachedCapabilities, newHeads: 'poll-only' }
    }
  }

  /**
   * Fetch the full transaction by hash and emit a single-tx
   * NormalizedMempool snapshot into mempoolSubs. Called from the WS
   * `newPendingTransactions` subscription's `onData` handler for each
   * hash-only push notification.
   *
   * Hash-only normalization: the WS payload carries only a hash; this
   * function fetches the full tx and wraps it in the canonical
   * NormalizedMempool shape so consumers see one consistent type
   * regardless of whether the data arrived via push or poll.
   */
  const handleMempoolNotification = async (hash: string): Promise<void> => {
    const tx = await fetchTransaction(
      options.client,
      hash,
      errSink('eth_getTransactionByHash'),
    )
    if (!tx?.from || !tx.nonce) return
    const sender = tx.from.toLowerCase()
    let nonceKey: string
    try {
      nonceKey = BigInt(tx.nonce).toString(10)
    } catch {
      // Unparseable nonce — use the raw value rather than dropping the
      // tx entirely; downstream lookup helpers handle unexpected keys.
      nonceKey = tx.nonce
    }
    const snapshot: NormalizedMempool = {
      pending: { [sender]: { [nonceKey]: tx } },
      queued: {},
    }
    mempoolSubs.emit(snapshot)
  }

  /**
   * Open one `eth_subscribe('newPendingTransactions')` lazily — called
   * once the probe has resolved and confirmed
   * `newPendingTransactions === 'subscription'`. Push notifications carry
   * a hash only; each hash is piped through `handleMempoolNotification`
   * which fetches the full tx and emits a single-tx NormalizedMempool
   * snapshot. Push and poll coexist — mempool snapshots are
   * intentionally not deduped. Failure downgrades the cached capability
   * and surfaces via `onError`; the poll cycle continues unchanged.
   *
   * No idempotency flag is needed here: start() is already gated by the
   * outer `started` flag (preventing double-subscription within one
   * start cycle), and stop()/start() resume legitimately requires this
   * function to run again — stop() sets mempoolSubscriptionHandle = null
   * so the next call opens a fresh subscription cleanly.
   */
  const tryOpenMempoolSubscription = async (): Promise<void> => {
    if (!fetchMempool) return
    if (cachedCapabilities.newPendingTransactions !== 'subscription') return
    try {
      mempoolSubscriptionHandle = await wsTransport.subscribe({
        params: ['newPendingTransactions'],
        // Push notifications carry a hash (string) on most providers;
        // some send full-tx objects — extract .hash as a fallback.
        onData: (data: unknown) => {
          const hash =
            typeof data === 'string' ? data : (data as { hash?: string }).hash
          if (!hash) return
          void handleMempoolNotification(hash)
        },
        onError: (err) =>
          options.onError?.('eth_subscribe.newPendingTransactions', err),
      })
    } catch (err) {
      options.onError?.('eth_subscribe.newPendingTransactions', err)
      cachedCapabilities = {
        ...cachedCapabilities,
        newPendingTransactions:
          cachedCapabilities.txpoolContent === 'available'
            ? 'poll-only'
            : 'unavailable',
      }
    }
  }

  // Eager capability probe. Fire-and-forget; consumers that need a
  // guaranteed-completed probe await source.ready().
  const readyPromise: Promise<void> = probeCapabilities(options.client, {
    onError: options.onError,
  }).then((caps) => {
    cachedCapabilities = caps
  })

  // One poll cycle. Cheap `eth_blockNumber` probe + (optionally)
  // mempool fetch in parallel; if the probe shows the head has
  // advanced (or the probe failed and we're falling through
  // defensively), follow up with the expensive full-block fetch.
  // Mempool emits every successful cycle; blocks emit only when the
  // observed hash changes.
  const tick = async (): Promise<void> => {
    const [head, txPool] = await Promise.all([
      fetchHeadBlockNumber(options.client, errSink('eth_blockNumber')),
      fetchMempool
        ? fetchTxPool(options.client, errSink('txpool_content'))
        : Promise.resolve(null),
    ])

    // Head-probe gate: skip the full-block fetch when the probe says
    // the head hasn't moved since we last observed it. A null probe
    // (RPC method gated, transport error) falls through to fetch —
    // we'd rather pay one extra block fetch than block on a flaky
    // upstream that can't even report `eth_blockNumber`.
    const headChanged =
      head === null ||
      lastSeenBlockNumber === undefined ||
      head !== lastSeenBlockNumber
    const block = headChanged
      ? await fetchBlock(options.client, 'latest', errSink('eth_getBlockByNumber'))
      : null

    if (block) {
      // Update the gate state from the actually-fetched block, not
      // from the probe's number — keeps the gate consistent with
      // what consumers observed.
      try {
        lastSeenBlockNumber = BigInt(block.number)
      } catch {
        // Block number didn't decode — leave gate state untouched so
        // we re-fetch on the next tick rather than persist garbage.
      }
      if (block.hash !== lastEmittedBlockHash) {
        lastEmittedBlockHash = block.hash
        blockSubs.emit(block)
      }
    }
    // Mempool is intentionally not deduped — txs come and go between
    // blocks even on a static head, so every successful snapshot is
    // fresh data. Only the block stream dedups.
    if (txPool && fetchMempool) {
      mempoolSubs.emit(normalizeMempool(txPool))
    }
  }

  return {
    start: () => {
      if (started) return
      started = true
      // Fire the first tick immediately so consumers don't wait one
      // full interval for their first event. The interval timer
      // takes over from there.
      void tick()
      timer = setInterval(() => {
        void tick()
      }, pollIntervalMs)
      // Open WS subscribes lazily once the probe has landed. Fire-and-
      // forget; failures fall through to the existing poll loop.
      void readyPromise.then(() => tryOpenBlockSubscription())
      void readyPromise.then(() => tryOpenMempoolSubscription())
    },

    stop: () => {
      if (blockSubscriptionHandle) {
        try {
          blockSubscriptionHandle.unsubscribe()
        } catch (err) {
          options.onError?.('eth_unsubscribe', err)
        }
        blockSubscriptionHandle = null
      }
      if (mempoolSubscriptionHandle) {
        try {
          mempoolSubscriptionHandle.unsubscribe()
        } catch (err) {
          options.onError?.('eth_unsubscribe', err)
        }
        mempoolSubscriptionHandle = null
      }
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      started = false
      // Subscriber registry is intentionally preserved across stop —
      // a start/stop/start pattern keeps existing subscriptions
      // alive, matching the gas-oracle convention. Block-dedup +
      // head-probe-gate state ARE reset though: a consumer that
      // paused and resumed should get a current snapshot on first
      // re-tick rather than wait for the next chain block, and the
      // gate must defensively re-fetch in case the chain advanced
      // (or reorged) during the pause.
      lastEmittedBlockHash = undefined
      lastSeenBlockNumber = undefined
    },

    pollOnce: () => tick(),

    ready: () => readyPromise,

    subscribeBlocks: (cb) => blockSubs.subscribe(cb),

    subscribeMempool: (cb) => mempoolSubs.subscribe(cb),

    getBlock: (tag) =>
      fetchBlock(options.client, tag, errSink('eth_getBlockByNumber')),

    getBlockByHash: (hash) =>
      fetchBlockByHash(options.client, hash, errSink('eth_getBlockByHash')),

    getFeeHistory: (blockCount, percentiles) =>
      fetchFeeHistory(
        options.client,
        blockCount,
        percentiles,
        errSink('eth_feeHistory'),
      ),

    getMempoolSnapshot: async () => {
      const txPool = await fetchTxPool(options.client, errSink('txpool_content'))
      return txPool ? normalizeMempool(txPool) : null
    },

    getReceipt: (hash) =>
      fetchReceipt(options.client, hash, errSink('eth_getTransactionReceipt')),

    getTransaction: (hash) =>
      fetchTransaction(options.client, hash, errSink('eth_getTransactionByHash')),

    capabilities: () => cachedCapabilities,
  }
}
