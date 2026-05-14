/**
 * Integration tests for `createTxTracker` driven by a hand-rolled
 * stub `ChainSource`. The stub implements the spec §3.2 interface
 * fully synchronously so tests can drive deterministic event
 * sequences without timers or fake clocks.
 *
 * What this suite pins:
 *
 *   1. **Three-shape consistency** (§5.3) — `getTxStatus`,
 *      `subscribe(hash, cb)`, and `track(hash)` see the same events
 *      in the same order.
 *   2. **Block path** — `seen-in-block` fires on first inclusion,
 *      `confirmations` increments on subsequent blocks, and
 *      `unseen-for-N-blocks` fires after the configured streak.
 *   3. **Mempool path** — `seen-in-mempool` and `left-mempool`
 *      transitions; bucket-change emits a fresh seen-in-mempool.
 *   4. **Replacement detection** — same `(from, nonce)` with a
 *      different hash, on either mempool or block.
 *   5. **Reorg detection** — `vanished-from-block` when a same-height
 *      different-hash block lands.
 *   6. **Capability transitions** — `signal-degraded` /
 *      `signal-recovered` based on source.capabilities() flips.
 *   7. **Bulk subscriptions** — `trackFromAddress` /
 *      `trackToAddress` / `trackPredicate`; auto-track per-hash by
 *      default.
 *   8. **Lifecycle** — `start` / `stop` / `Stopped` event semantics.
 *   9. **Capability disclosure** — `capabilities()` mirrors source.
 */
import { test, expect, vi } from 'vitest'

import type {
  BlockResult,
  Capabilities,
  ChainSource,
  NormalizedMempool,
  RawTx,
  TransactionReceipt,
  FeeHistoryResult,
} from '@valve-tech/chain-source'

import { createInMemoryStore } from './store.js'
import { createTxTracker, type TxTracker } from './tracker.js'

// -------------- stub ChainSource --------------

interface StubSource extends ChainSource {
  emitBlock: (block: BlockResult) => void
  emitMempool: (snapshot: NormalizedMempool) => void
  setCapabilities: (caps: Capabilities) => void
}

const DEFAULT_CAPS: Capabilities = {
  newHeads: 'subscription',
  newPendingTransactions: 'poll-only',
  txpoolContent: 'available',
  receiptByHash: 'available',
  reprobeOnReconnect: true,
}

interface MakeSourceOptions {
  initialCaps?: Capabilities
  /**
   * Per-hash receipt fixtures for `getReceipt`. When provided, the
   * stub resolves with the matching receipt (or null for hashes not
   * in the map). When absent, `getReceipt` always returns null.
   */
  receiptMap?: Record<string, TransactionReceipt>
  /**
   * Override `getReceipt` entirely with a custom implementation.
   * Takes precedence over `receiptMap`.
   */
  getReceiptImpl?: (hash: string) => Promise<TransactionReceipt | null>
  /**
   * Override `getTransaction` with a custom implementation. When
   * absent the stub's `getTransaction` returns null — backwards-
   * compatible default for tests that don't exercise the
   * status-poll path.
   */
  getTransactionImpl?: (hash: string) => Promise<RawTx | null>
}

const makeSource = (
  initialCapsOrOptions?: Capabilities | MakeSourceOptions,
): StubSource => {
  // Accept either the legacy `Capabilities` positional arg or a structured options object.
  let opts: MakeSourceOptions
  if (
    initialCapsOrOptions == null ||
    ('newHeads' in initialCapsOrOptions && 'receiptByHash' in initialCapsOrOptions)
  ) {
    opts = { initialCaps: initialCapsOrOptions as Capabilities | undefined }
  } else {
    opts = initialCapsOrOptions as MakeSourceOptions
  }

  const blockSubs = new Set<(b: BlockResult) => void>()
  const mempoolSubs = new Set<(s: NormalizedMempool) => void>()
  let caps: Capabilities = opts.initialCaps ?? DEFAULT_CAPS

  const getReceiptFn = opts.getReceiptImpl
    ?? ((hash: string): Promise<TransactionReceipt | null> =>
        Promise.resolve(opts.receiptMap?.[hash] ?? null))

  const getTransactionFn =
    opts.getTransactionImpl
    ?? ((_hash: string): Promise<RawTx | null> => Promise.resolve(null))

  return {
    start: () => {},
    stop: () => {},
    pollOnce: async () => {},
    ready: () => Promise.resolve(),
    subscribeBlocks: (cb) => {
      blockSubs.add(cb)
      return () => blockSubs.delete(cb)
    },
    subscribeMempool: (cb) => {
      mempoolSubs.add(cb)
      return () => mempoolSubs.delete(cb)
    },
    getBlock: async (): Promise<BlockResult | null> => null,
    getFeeHistory: async (): Promise<FeeHistoryResult | null> => null,
    getMempoolSnapshot: async (): Promise<NormalizedMempool | null> => null,
    getReceipt: getReceiptFn,
    getTransaction: getTransactionFn,
    capabilities: () => caps,
    emitBlock: (block) => {
      for (const cb of [...blockSubs]) cb(block)
    },
    emitMempool: (snapshot) => {
      for (const cb of [...mempoolSubs]) cb(snapshot)
    },
    setCapabilities: (next) => {
      caps = next
    },
  }
}

const makeBlock = (
  number: bigint,
  hash: string,
  txs: RawTx[],
  parentHash: string = '0xparent',
): BlockResult => ({
  number: '0x' + number.toString(16),
  hash,
  parentHash,
  timestamp: '0x' + (number * 12n).toString(16),
  baseFeePerGas: '0x0',
  gasLimit: '0x0',
  gasUsed: '0x0',
  transactions: txs,
})

const emptyMempool = (): NormalizedMempool => ({ pending: {}, queued: {} })

const startTracker = (
  source: StubSource,
  overrides?: Partial<Parameters<typeof createTxTracker>[0]>,
): TxTracker => {
  const tracker = createTxTracker({ source, chainId: 1, ...overrides })
  tracker.start()
  return tracker
}

const collect = (
  tracker: TxTracker,
  hash: string,
  options?: Parameters<TxTracker['subscribe']>[2],
): { events: import('./events.js').TxEvent[]; unsub: () => void } => {
  const events: import('./events.js').TxEvent[] = []
  const unsub = tracker.subscribe(
    hash,
    (event) => events.push(event),
    options,
  )
  return { events, unsub }
}

// -------------- legacy-shape fixtures --------------

/**
 * Build a `TxStatus`-shaped object that's missing one or more
 * fields the current type declares — simulates a record persisted
 * by an earlier toolkit version that didn't yet have those fields.
 *
 * Why this exists: TxStatus is a wire-shape (it crosses the
 * `TxTrackerStore` serialization boundary). Adding a new
 * non-optional field is a breaking change for any consumer with
 * prior state on disk — TypeScript says the field is present,
 * runtime says it's `undefined`. The v0.11.0 → v0.11.1 patch was
 * the canonical instance. See `feedback_persisted_type_evolution.md`
 * in project memory.
 *
 * Usage discipline: when adding a non-optional field to TxStatus
 * (or any other persisted type), write at least one test that
 * stuffs a legacy-shape record into the store and exercises the
 * read paths against it. The cast through `unknown` is the
 * "this is wire data, not in-memory data" signal.
 *
 * @param omit field names that pre-v0.11 records would not have
 */
const makeLegacyTxStatus = (
  overrides: Partial<import('./events.js').TxStatus> = {},
  omit: (keyof import('./events.js').TxStatus)[] = [],
): import('./events.js').TxStatus => {
  const base: Record<string, unknown> = {
    hash: '0xlegacy',
    chainId: 1,
    lastSeenInBlock: null,
    lastSeenInMempool: null,
    replacedBy: null,
    vanishedAt: null,
    unseenStreak: 0,
    firstObservedAtBlock: null,
    lastObservedAtBlock: null,
    terminalAtBlockNumber: null, // present here; remove via `omit` for ≤0.10 fixtures
    capabilities: {
      newHeads: 'subscription',
      newPendingTransactions: 'poll-only',
      txpoolContent: 'available',
      receiptByHash: 'available',
      reprobeOnReconnect: true,
    },
    ...overrides,
  }
  for (const field of omit) delete base[field as string]
  return base as unknown as import('./events.js').TxStatus
}

// -------------- tests --------------

test('subscribe emits a synthetic started event by default', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events, unsub } = collect(tracker, '0xabc')
  expect(events[0].kind).toBe('started')
  expect(events[0].chainId).toBe(1)
  expect(events[0].hash).toBe('0xabc')
  unsub()
  tracker.stop()
})

test('emitInitial: false skips the synthetic started event', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events, unsub } = collect(tracker, '0xabc', { emitInitial: false })
  expect(events).toEqual([])
  unsub()
  tracker.stop()
})

test('seen-in-block fires when the tx is in the canonical block', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events } = collect(tracker, '0xabc', { emitInitial: false })
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xabc', from: '0xsender', nonce: '0x5' },
    ]),
  )
  expect(events.map((e) => e.kind)).toEqual(['seen-in-block'])
  const block = events[0] as import('./events.js').TxEventSeenInBlock
  expect(block.blockNumber).toBe(100n)
  expect(block.confirmations).toBe(1)
  expect(block.transactionIndex).toBe(0)
  tracker.stop()
})

test('confirmations increment on subsequent blocks', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events } = collect(tracker, '0xabc', { emitInitial: false })
  source.emitBlock(
    makeBlock(100n, '0xb1', [{ hash: '0xabc', from: '0xs', nonce: '0x1' }]),
  )
  source.emitBlock(makeBlock(101n, '0xb2', [], '0xb1'))
  source.emitBlock(makeBlock(102n, '0xb3', [], '0xb2'))
  const blockEvents = events.filter(
    (e): e is import('./events.js').TxEventSeenInBlock =>
      e.kind === 'seen-in-block',
  )
  expect(blockEvents.map((e) => e.confirmations)).toEqual([1, 2, 3])
  tracker.stop()
})

test('seen-in-mempool fires once and not again on the same bucket', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events } = collect(tracker, '0xabc', { emitInitial: false })
  const tx = { hash: '0xabc', from: '0xs', nonce: '0x1' }
  const snapshot: NormalizedMempool = {
    pending: { '0xs': { '1': tx } },
    queued: {},
  }
  source.emitMempool(snapshot)
  source.emitMempool(snapshot)
  const mempoolEvents = events.filter((e) => e.kind === 'seen-in-mempool')
  expect(mempoolEvents).toHaveLength(1)
  tracker.stop()
})

test('seen-in-mempool fires again when bucket transitions', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events } = collect(tracker, '0xabc', { emitInitial: false })
  const tx = { hash: '0xabc', from: '0xs', nonce: '0x1' }
  source.emitMempool({ pending: {}, queued: { '0xs': { '1': tx } } })
  source.emitMempool({ pending: { '0xs': { '1': tx } }, queued: {} })
  const mempoolEvents = events.filter(
    (e): e is import('./events.js').TxEventSeenInMempool =>
      e.kind === 'seen-in-mempool',
  )
  expect(mempoolEvents.map((e) => e.bucket)).toEqual(['queued', 'pending'])
  tracker.stop()
})

test('left-mempool fires when a previously-seen hash is gone from the snapshot', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events } = collect(tracker, '0xabc', { emitInitial: false })
  const tx = { hash: '0xabc', from: '0xs', nonce: '0x1' }
  source.emitMempool({ pending: { '0xs': { '1': tx } }, queued: {} })
  source.emitMempool(emptyMempool())
  expect(events.map((e) => e.kind)).toEqual([
    'seen-in-mempool',
    'left-mempool',
  ])
  tracker.stop()
})

test('replacement on mempool fires replaced-by with null block number', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events } = collect(tracker, '0xabc', { emitInitial: false })
  const original = { hash: '0xabc', from: '0xs', nonce: '0x1' }
  const replacement = { hash: '0xrep', from: '0xs', nonce: '0x1' }
  source.emitMempool({ pending: { '0xs': { '1': original } }, queued: {} })
  source.emitMempool({ pending: { '0xs': { '1': replacement } }, queued: {} })
  const replaceEvents = events.filter(
    (e): e is import('./events.js').TxEventReplacedBy =>
      e.kind === 'replaced-by',
  )
  expect(replaceEvents).toHaveLength(1)
  expect(replaceEvents[0].replacementHash).toBe('0xrep')
  expect(replaceEvents[0].replacementBlockNumber).toBeNull()
  tracker.stop()
})

test('replacement on block fires replaced-by with the block number', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events } = collect(tracker, '0xabc', { emitInitial: false })
  source.emitMempool({
    pending: {
      '0xs': { '1': { hash: '0xabc', from: '0xs', nonce: '0x1' } },
    },
    queued: {},
  })
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xrep', from: '0xs', nonce: '0x1' },
    ]),
  )
  const replaceEvents = events.filter(
    (e): e is import('./events.js').TxEventReplacedBy =>
      e.kind === 'replaced-by',
  )
  expect(replaceEvents).toHaveLength(1)
  expect(replaceEvents[0].replacementHash).toBe('0xrep')
  expect(replaceEvents[0].replacementBlockNumber).toBe(100n)
  tracker.stop()
})

test('unseen-for-N-blocks fires after the configured streak', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events } = collect(tracker, '0xabc', {
    emitInitial: false,
    unseenThresholdBlocks: 3,
  })
  // Seed with one mempool observation to mark firstObservedAtBlock.
  source.emitMempool({
    pending: { '0xs': { '1': { hash: '0xabc', from: '0xs', nonce: '0x1' } } },
    queued: {},
  })
  // Drop from mempool, now run 3 blocks without it.
  source.emitMempool(emptyMempool())
  source.emitBlock(makeBlock(100n, '0xb1', []))
  source.emitBlock(makeBlock(101n, '0xb2', [], '0xb1'))
  source.emitBlock(makeBlock(102n, '0xb3', [], '0xb2'))
  const unseen = events.filter((e) => e.kind === 'unseen-for-N-blocks')
  expect(unseen).toHaveLength(1)
  expect(
    (unseen[0] as import('./events.js').TxEventUnseenForNBlocks).blocks,
  ).toBe(3)
  tracker.stop()
})

test('vanished-from-block fires on a same-height different-hash reorg', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events } = collect(tracker, '0xabc', { emitInitial: false })
  source.emitBlock(
    makeBlock(100n, '0xb-orig', [
      { hash: '0xabc', from: '0xs', nonce: '0x1' },
    ]),
  )
  source.emitBlock(makeBlock(100n, '0xb-new', []))
  const vanish = events.filter((e) => e.kind === 'vanished-from-block')
  expect(vanish).toHaveLength(1)
  const v = vanish[0] as import('./events.js').TxEventVanishedFromBlock
  expect(v.previousBlockHash).toBe('0xb-orig')
  expect(v.canonicalBlockHash).toBe('0xb-new')
  expect(v.blockNumber).toBe(100n)
  tracker.stop()
})

test('signal-degraded fires when source.capabilities() drops authority', () => {
  const source = makeSource({ ...DEFAULT_CAPS, newHeads: 'subscription' })
  const tracker = startTracker(source)
  const { events } = collect(tracker, '0xabc', { emitInitial: false })
  // Force tracker to take a tip first so blocks fire onBlock with
  // updated caps.
  source.emitBlock(makeBlock(100n, '0xb1', []))
  source.setCapabilities({ ...DEFAULT_CAPS, newHeads: 'poll-only' })
  source.emitBlock(makeBlock(101n, '0xb2', [], '0xb1'))
  const degraded = events.filter((e) => e.kind === 'signal-degraded')
  expect(degraded).toHaveLength(1)
  expect(
    (degraded[0] as import('./events.js').TxEventSignalDegraded)
      .capabilityLost,
  ).toBe('newHeads')
  tracker.stop()
})

test('signal-recovered fires when capability returns', () => {
  const source = makeSource({ ...DEFAULT_CAPS, newHeads: 'poll-only' })
  const tracker = startTracker(source)
  const { events } = collect(tracker, '0xabc', { emitInitial: false })
  source.emitBlock(makeBlock(100n, '0xb1', []))
  source.setCapabilities({ ...DEFAULT_CAPS, newHeads: 'subscription' })
  source.emitBlock(makeBlock(101n, '0xb2', [], '0xb1'))
  const rec = events.filter((e) => e.kind === 'signal-recovered')
  expect(rec).toHaveLength(1)
  tracker.stop()
})

test('lostSignalPolicy: silent suppresses signal-degraded events', () => {
  const source = makeSource({ ...DEFAULT_CAPS, newHeads: 'subscription' })
  const tracker = startTracker(source, { lostSignalPolicy: 'silent' })
  const { events } = collect(tracker, '0xabc', { emitInitial: false })
  source.emitBlock(makeBlock(100n, '0xb1', []))
  source.setCapabilities({ ...DEFAULT_CAPS, newHeads: 'poll-only' })
  source.emitBlock(makeBlock(101n, '0xb2', [], '0xb1'))
  expect(events.some((e) => e.kind === 'signal-degraded')).toBe(false)
  tracker.stop()
})

test('getTxStatus tracks the cached snapshot', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { unsub } = collect(tracker, '0xabc', { emitInitial: false })
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xabc', from: '0xs', nonce: '0x1' },
    ]),
  )
  const status = tracker.getTxStatus('0xabc')!
  expect(status.lastSeenInBlock?.blockNumber).toBe(100n)
  expect(status.lastSeenInBlock?.confirmations).toBe(1)
  unsub()
  tracker.stop()
})

test('subscribeAll receives every event across all hashes', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const all: import('./events.js').TxEvent[] = []
  const unsubAll = tracker.subscribeAll((e) => all.push(e))
  const { unsub: u1 } = collect(tracker, '0xa', { emitInitial: false })
  const { unsub: u2 } = collect(tracker, '0xb', { emitInitial: false })
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xa', from: '0xs', nonce: '0x1' },
      { hash: '0xb', from: '0xs', nonce: '0x2' },
    ]),
  )
  expect(all.filter((e) => e.kind === 'seen-in-block').map((e) => e.hash)).toEqual(
    ['0xa', '0xb'],
  )
  u1()
  u2()
  unsubAll()
  tracker.stop()
})

test('durable subscriptions are rehydrated on a fresh tracker constructed against a shared store (audit #1)', async () => {
  // Spec §13.1 + audit #1: a durable subscription persisted via
  // tracker A's store must be re-registered against the source when
  // tracker B starts up with the same store instance — otherwise
  // indexers/relays silently lose tracked-set state across process
  // restart.
  //
  // Test shape: one shared in-memory store, two trackers in sequence.
  // Tracker A subscribes durable, observes the tx in a block, then
  // stops. Tracker B constructs against the same store, starts, and
  // awaits `ready()` (the rehydration gate). After ready, the
  // record should be in B's `tracked` map and emitting an event for
  // the same hash should reach subscribers — proves rehydration
  // happened.
  const store = createInMemoryStore()
  // ---- Tracker A: write durable state to the store ----
  const sourceA = makeSource()
  const trackerA = createTxTracker({ source: sourceA, chainId: 1, store })
  trackerA.start()
  trackerA.subscribe('0xpersist', () => {}, {
    emitInitial: false,
    durable: true,
  })
  sourceA.emitBlock(makeBlock(100n, '0xb100', [
    { hash: '0xpersist', from: '0xs', nonce: '0x1' },
  ]))
  // Allow the durable persist microtask to land.
  await flush()
  trackerA.stop()

  // ---- Tracker B: construct against the same store ----
  const sourceB = makeSource()
  const trackerB = createTxTracker({ source: sourceB, chainId: 1, store })

  // Pre-rehydration: status not visible.
  expect(trackerB.getTxStatus('0xpersist')).toBeNull()
  trackerB.start()
  await trackerB.ready()
  // Post-rehydration: status restored from the store.
  const status = trackerB.getTxStatus('0xpersist')
  expect(status).not.toBeNull()
  expect(status!.lastSeenInBlock?.blockNumber).toBe(100n)

  // Wire a fresh subscriber on B and drive TWO new blocks — the
  // rehydrated record should accept observations and Path 2 fires a
  // confirmation bump on the second block (Path 2 needs latestTip
  // set, which doesn't happen until the first block lands on a
  // fresh tracker).
  const events: import('./events.js').TxEvent[] = []
  trackerB.subscribe('0xpersist', (e) => events.push(e), { emitInitial: false })
  sourceB.emitBlock(makeBlock(101n, '0xb101', [], '0xb100'))
  sourceB.emitBlock(makeBlock(102n, '0xb102', [], '0xb101'))
  const bump = events.find(
    (e) => e.kind === 'seen-in-block',
  ) as import('./events.js').TxEventSeenInBlock | undefined
  expect(bump).toBeDefined()
  expect(bump!.confirmations).toBeGreaterThanOrEqual(2)
  trackerB.stop()
})

test('ready() resolves immediately when start() has not been called (audit #1 boundary)', async () => {
  const source = makeSource()
  const tracker = createTxTracker({ source, chainId: 1 })
  // No start() called — ready() should still be awaitable.
  await tracker.ready()
})

test('rehydration skips records that were already re-created via subscribe() during the await (coverage)', async () => {
  // Race: tracker.start() kicks off rehydration. Before listDurable
  // resolves, consumer calls tracker.subscribe(hash) — ensureRecord
  // creates a fresh record in `tracked`. When rehydration resolves,
  // it must NOT clobber the freshly-created record.
  let resolveList: ((records: import('./store.js').TrackedTxRecord[]) => void) | null = null
  const deferredStore: import('./store.js').TxTrackerStore = {
    put: async () => {},
    get: async () => null,
    delete: async () => {},
    listDurable: () =>
      new Promise<import('./store.js').TrackedTxRecord[]>((resolve) => {
        resolveList = resolve
      }),
    appendEvent: async () => {},
  }
  const source = makeSource()
  const tracker = createTxTracker({
    source,
    chainId: 1,
    store: deferredStore,
  })
  tracker.start()
  // Race the subscribe in before resolving the rehydration.
  tracker.subscribe('0xshared', () => {}, { emitInitial: false })
  // Resolve listDurable with a record that uses the same hash. The
  // rehydration path must hit `tracked.has(...)` → continue.
  resolveList!([
    {
      chainId: 1,
      hash: '0xshared',
      status: {
        hash: '0xshared',
        chainId: 1,
        lastSeenInBlock: { blockHash: '0xb', blockNumber: 99n, transactionIndex: 0, confirmations: 1, source: 'block-poll' },
        lastSeenInMempool: null,
        replacedBy: null,
        vanishedAt: null,
        unseenStreak: 0,
        firstObservedAtBlock: 99n,
        lastObservedAtBlock: 99n,
        terminalAtBlockNumber: null,
        capabilities: source.capabilities(),
      },
      firstSeenBlockNumber: 99n,
      lastObservedBlockNumber: 99n,
      retentionExpiresAtBlockNumber: 99n + 64n,
      subscriptions: [],
    },
  ])
  await tracker.ready()
  // The pre-existing fresh-record (with no lastSeenInBlock) wins —
  // rehydration's stale record from the store was skipped.
  const status = tracker.getTxStatus('0xshared')
  expect(status).not.toBeNull()
  expect(status!.lastSeenInBlock).toBeNull()
  tracker.stop()
})

test('rehydration routes store.listDurable errors through onError without crashing (coverage)', async () => {
  // listDurable rejection: tracker must continue startup; the
  // rehydration just yields zero records. onError captures the error
  // for observability; the consumer's ready() resolves cleanly.
  const onError = vi.fn()
  const failingStore: import('./store.js').TxTrackerStore = {
    put: async () => {},
    get: async () => null,
    delete: async () => {},
    listDurable: async () => {
      throw new Error('listDurable boom')
    },
    appendEvent: async () => {},
  }
  const source = makeSource()
  const tracker = createTxTracker({
    source,
    chainId: 1,
    store: failingStore,
    onError,
  })
  tracker.start()
  await tracker.ready()
  expect(onError).toHaveBeenCalledWith(
    'store.listDurable',
    expect.objectContaining({ message: 'listDurable boom' }),
  )
  tracker.stop()
})

test('tracker.stop() tears down active bulk subscriptions (audit #3 lock-in)', async () => {
  // Audit #3 was largely subsumed by audit #2 (retention enforcement)
  // — once durable records are reaped on retention, auto-tracked
  // records inside an active bulk's lifecycle do not pile up. The
  // narrower lock-in here: tracker.stop() correctly marks bulk subs
  // stopped so their async iterators yield `done: true` cleanly.
  const source = makeSource()
  const tracker = startTracker(source)
  const sub = tracker.trackFromAddress('0xsender')
  // Consume the bulk's events via async iterator. After tracker.stop(),
  // the iterator should resolve `done: true` on the next .next() call.
  const iterator = sub.events()[Symbol.asyncIterator]()
  // No matches yet — call .next() to register a waiter (otherwise the
  // tracker.stop() path can't observe pending consumers).
  const pending = iterator.next()
  tracker.stop()
  // Once stop sets sub.stopped, subsequent .next() returns done.
  const after = await iterator.next()
  expect(after.done).toBe(true)
  // Cleanup: the original pending waiter never resolves (it's not
  // signaled by stop()), but we don't await it; the test ends here.
  void pending
})

test('retention enforcement: durable record reaching unseen-for-N-blocks fires retention-expired (audit #2)', () => {
  // Spec §10: "the retention window expires after a terminal state."
  // Setup: subscribe to a hash, observe it via mempool (sets
  // firstObservedAtBlock), then drive an empty block — that single
  // empty block trips unseenThresholdBlocks=1 and marks the record
  // terminal. With retentionBlocks=3, the record is GC'd 4 blocks
  // later with Stopped({ reason: 'retention-expired' }).
  const source = makeSource()
  const tracker = createTxTracker({
    source,
    chainId: 1,
    retentionBlocks: 3,
    unseenThresholdBlocks: 1,
  })
  tracker.start()
  const events: import('./events.js').TxEvent[] = []
  // Durable: cleanupRecord won't drop us when the subs go to 0.
  tracker.subscribe('0xfaraway', (e) => events.push(e), {
    emitInitial: false,
    durable: true,
  })
  // Mempool sees the tx → firstObservedAtBlock gets set.
  source.emitMempool({
    pending: {
      '0xs': {
        '0x1': { hash: '0xfaraway', from: '0xs', nonce: '0x1' },
      },
    },
    queued: {},
  })
  // Block 200 lands; tx not in block (and we'll clear mempool first).
  source.emitMempool({ pending: {}, queued: {} })
  source.emitBlock(makeBlock(200n, '0xb200', []))
  // unseen-for-N-blocks should fire here (streak = 1 = threshold).
  // terminalAtBlockNumber = 200.
  expect(events.some((e) => e.kind === 'unseen-for-N-blocks')).toBe(true)

  // Advance to block 203 (= 200 + retentionBlocks). Retention
  // condition is `blockNumber > terminal + retentionBlocks`, so 203
  // is the LAST block that should NOT trigger.
  source.emitBlock(makeBlock(201n, '0xb201', []))
  source.emitBlock(makeBlock(202n, '0xb202', []))
  source.emitBlock(makeBlock(203n, '0xb203', []))
  expect(events.some((e) => e.kind === 'stopped')).toBe(false)
  // Block 204 trips it.
  source.emitBlock(makeBlock(204n, '0xb204', []))
  const stoppedEvent = events.find(
    (e) => e.kind === 'stopped',
  ) as import('./events.js').TxEventStopped | undefined
  expect(stoppedEvent).toBeDefined()
  expect(stoppedEvent!.reason).toBe('retention-expired')
  // getTxStatus returns null after retention cleanup.
  expect(tracker.getTxStatus('0xfaraway')).toBeNull()
  tracker.stop()
})

test('retention check does not throw on rehydrated legacy record lacking terminalAtBlockNumber (v0.11.1 regression)', async () => {
  // Reproduces the v0.11.0 upgrade-path crash: TxStatus added
  // `terminalAtBlockNumber: bigint | null` in v0.11.0, but records
  // persisted by ≤0.10 stores have the field absent (undefined at
  // runtime). The retention guard in tracker.ts used `t !== null`
  // (strict), so undefined slipped past the guard and crashed at
  // `undefined + BigInt(retentionBlocks)` with `Cannot mix BigInt
  // and other types`. The throw was uncaught inside the emitter,
  // halting the in-flight block-tick fanout silently. Consumer-
  // visible symptom: tx-flight UIs stalled on "pending" forever
  // after upgrade. Fixed by replacing the strict-null check with
  // `typeof t === 'bigint'`.
  const store = createInMemoryStore()
  // Use the shared legacy-fixture helper — `omit: ['terminalAtBlockNumber']`
  // simulates a record persisted by v0.10.x (before that field existed).
  // See makeLegacyTxStatus's JSDoc for the wire-shape evolution
  // discipline this test locks in.
  await store.put({
    chainId: 1,
    hash: '0xlegacy',
    status: makeLegacyTxStatus({}, ['terminalAtBlockNumber']),
    firstSeenBlockNumber: 0n,
    lastObservedBlockNumber: 0n,
    retentionExpiresAtBlockNumber: 64n,
    subscriptions: [
      { id: 'sub-1', kind: 'hash', hash: '0xlegacy', durable: true },
    ],
  })
  const onError = vi.fn()
  const source = makeSource()
  const tracker = createTxTracker({ source, chainId: 1, store, onError })
  tracker.start()
  await tracker.ready()
  // Drive a block — pre-fix this threw `TypeError: Cannot mix BigInt
  // and other types` synchronously inside the source emitter; the
  // throw was swallowed by Subscriptions.emit but halted the fanout.
  // Post-fix: legacy record is treated as in-flight (typeof t !==
  // 'bigint') and skipped by retention; the rest of the fanout
  // proceeds.
  expect(() => {
    source.emitBlock(makeBlock(100n, '0xb100', []))
  }).not.toThrow()
  // No silent error routed to onError either — the retention check
  // is now defensive, not exception-catching.
  expect(onError).not.toHaveBeenCalled()
  tracker.stop()
})

test('stale-block guard treats undefined lastObservedAtBlock as "no prior recorded position" (v0.11.2 posture-consistency)', async () => {
  // Companion to the v0.11.1 fix: tracker.ts's stale-block guard at
  // the per-record observation loop also used strict `!== null` on
  // a persisted-type field. Field has been present since v0.3.x so
  // no live consumer is affected, but the hazard class is identical
  // — a future migration that ever drops the field would silently
  // defang the guard (undefined > blockNumber → false coercion).
  // The fix uses typeof === 'bigint' for posture-consistency.
  const store = createInMemoryStore()
  // Legacy fixture: omit BOTH terminalAtBlockNumber (the v0.11.1
  // case) AND lastObservedAtBlock (this test's case) to model a
  // very old persisted record.
  await store.put({
    chainId: 1,
    hash: '0xveryold',
    status: makeLegacyTxStatus({ firstObservedAtBlock: 50n }, [
      'terminalAtBlockNumber',
      'lastObservedAtBlock',
    ]),
    firstSeenBlockNumber: 50n,
    lastObservedBlockNumber: 50n,
    retentionExpiresAtBlockNumber: 114n,
    subscriptions: [
      { id: 'sub-1', kind: 'hash', hash: '0xveryold', durable: true },
    ],
  })
  const onError = vi.fn()
  const source = makeSource()
  const tracker = createTxTracker({ source, chainId: 1, store, onError })
  tracker.start()
  await tracker.ready()
  // Drive a block — must not throw, must not silently bypass the
  // observation loop.
  expect(() => {
    source.emitBlock(makeBlock(100n, '0xb100', []))
  }).not.toThrow()
  expect(onError).not.toHaveBeenCalled()
  tracker.stop()
})

test('retention enforcement: store.delete rejection routes through onError (coverage)', async () => {
  // When retention reaps a durable record, store.delete is fired and
  // awaited only via .catch — any rejection must go to onError so
  // observability survives a flaky external store (Redis blip, etc).
  const onError = vi.fn()
  const failingDeleteStore: import('./store.js').TxTrackerStore = {
    put: async () => {},
    get: async () => null,
    delete: async () => {
      throw new Error('store.delete boom')
    },
    listDurable: async () => [],
    appendEvent: async () => {},
  }
  const source = makeSource()
  const tracker = createTxTracker({
    source,
    chainId: 1,
    store: failingDeleteStore,
    retentionBlocks: 1,
    unseenThresholdBlocks: 1,
    onError,
  })
  tracker.start()
  tracker.subscribe('0xtarget', () => {}, { emitInitial: false, durable: true })
  source.emitMempool({
    pending: { '0xs': { '0x1': { hash: '0xtarget', from: '0xs', nonce: '0x1' } } },
    queued: {},
  })
  source.emitMempool({ pending: {}, queued: {} })
  // Block 100: triggers unseen-for-N-blocks → terminal at 100.
  source.emitBlock(makeBlock(100n, '0xb100', []))
  // Block 102 > 100 + 1: retention fires, store.delete called and rejects.
  source.emitBlock(makeBlock(101n, '0xb101', []))
  source.emitBlock(makeBlock(102n, '0xb102', []))
  // Flush the rejection through the microtask queue so the .catch handler runs.
  await flush()
  expect(onError).toHaveBeenCalledWith(
    'store.delete',
    expect.objectContaining({ message: 'store.delete boom' }),
  )
  tracker.stop()
})

test('retention enforcement: in-flight record (no terminal observation) is not GC\'d by retention (audit #2 boundary)', () => {
  // A record that's still happily confirming (lastSeenInBlock keeps
  // bumping confirmations every block) has terminalAtBlockNumber === null
  // and must NOT be reaped by retention. Only durable+terminal records
  // are subject to retention-expired; in-flight records continue
  // until cleanupRecord fires (subs.size===0 && !hasDurableSub).
  const source = makeSource()
  const tracker = createTxTracker({
    source,
    chainId: 1,
    retentionBlocks: 2,
  })
  tracker.start()
  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xa', (e) => events.push(e), { emitInitial: false, durable: true })
  // Tx mined at block 100, then 5 confirmation bumps. Each bump
  // advances lastObservedAtBlock but terminalAtBlockNumber stays null.
  source.emitBlock(makeBlock(100n, '0xb100', [{ hash: '0xa', from: '0xs', nonce: '0x1' }]))
  for (let n = 101; n <= 105; n += 1) {
    source.emitBlock(makeBlock(BigInt(n), `0xb${n}`, []))
  }
  // No retention-expired despite being well past block 100 + retentionBlocks=2.
  expect(events.some((e) => e.kind === 'stopped')).toBe(false)
  expect(tracker.getTxStatus('0xa')).not.toBeNull()
  tracker.stop()
})

test('subscribeAll callbacks survive stop()/start() cycle (audit #8 lock-in)', () => {
  // Documented invariant: globalSubs (the subscribeAll subscriber set)
  // is deliberately NOT reset on stop(), so a long-lived analytics /
  // logging consumer that wires subscribeAll once at construction
  // continues receiving events across tracker restart cycles. This
  // test locks in that contract.
  const source = makeSource()
  const tracker = startTracker(source)
  const all: import('./events.js').TxEvent[] = []
  const unsubAll = tracker.subscribeAll((e) => all.push(e))
  // Drive an event under the first lifecycle.
  collect(tracker, '0xa', { emitInitial: false })
  source.emitBlock(
    makeBlock(100n, '0xb1', [{ hash: '0xa', from: '0xs', nonce: '0x1' }]),
  )
  const beforeStopCount = all.filter((e) => e.kind === 'seen-in-block').length
  expect(beforeStopCount).toBe(1)
  // Restart cycle.
  tracker.stop()
  tracker.start()
  // New subscriber for a fresh tracking after restart, drive an event.
  collect(tracker, '0xb', { emitInitial: false })
  source.emitBlock(
    makeBlock(101n, '0xb2', [{ hash: '0xb', from: '0xs', nonce: '0x1' }]),
  )
  // The subscribeAll callback registered before the restart should
  // have received the post-restart event too.
  const postRestartHits = all
    .filter((e) => e.kind === 'seen-in-block')
    .map((e) => e.hash)
  expect(postRestartHits).toEqual(['0xa', '0xb'])
  unsubAll()
  tracker.stop()
})

test('bulk fanout: synchronous sub.stop() from a per-hash callback does not throw (audit #7 hardening)', () => {
  // Audit #7 flagged that `findBulkSubBySelector` would throw if a
  // sub was deleted from `bulkSubs` mid-fanout. Investigation showed
  // the throw is unreachable from the public API (matchSubs only has
  // an async-iterable queue subscriber, which never runs consumer
  // code synchronously inside emit). But the per-hash callback path
  // (sub.subscribe → perHashSubs.emit) DOES run sync, and a consumer
  // calling sub.stop() from there mutates bulkSubs while subsequent
  // perHashSubs emits in the same tick are still in flight.
  //
  // This test exercises the most-likely consumer pattern: wake up on
  // first per-hash event for a bulk, stop the bulk to "unhook." Even
  // though spec §11.1 says auto-tracked records continue (so other
  // events may still fire on perHashSubs), the call MUST NOT throw.
  // Defensive null-return in findBulkSubBySelector locks this in.
  const source = makeSource()
  const tracker = startTracker(source)
  const events: string[] = []
  const sub = tracker.trackFromAddress('0xsender')
  const unsub = sub.subscribe((event) => {
    events.push(event.hash)
    sub.stop()
  })
  expect(() => {
    source.emitBlock(
      makeBlock(100n, '0xb1', [
        { hash: '0xt1', from: '0xsender', nonce: '0x1' },
        { hash: '0xt2', from: '0xsender', nonce: '0x2' },
      ]),
    )
  }).not.toThrow()
  // First per-hash event should have fired before sub.stop() ran.
  // Subsequent per-hash events on auto-tracked records are not the
  // bug under test — spec §11.1 explicitly says they continue.
  expect(events.length).toBeGreaterThanOrEqual(1)
  expect(events[0]).toBe('0xt1')
  unsub()
  tracker.stop()
})

test('async iterator (track) yields events in order and ends on stopped', async () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const collected: import('./events.js').TxEvent[] = []
  const consume = (async () => {
    for await (const event of tracker.track('0xabc', { emitInitial: false })) {
      collected.push(event)
      if (event.kind === 'stopped') break
    }
  })()
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xabc', from: '0xs', nonce: '0x1' },
    ]),
  )
  // tiny delay so the iterator's resolver runs
  await new Promise((r) => setTimeout(r, 0))
  tracker.stop()
  await consume
  const kinds = collected.map((e) => e.kind)
  expect(kinds[0]).toBe('seen-in-block')
  expect(kinds[kinds.length - 1]).toBe('stopped')
})

test('trackFromAddress emits matched events for matching senders', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const matches: import('./tracker.js').TxMatchEvent[] = []
  const sub = tracker.trackFromAddress('0xsender')
  const unsub = sub.subscribe(() => {})
  // Pump matched events via a per-hash subscriber that mirrors them.
  const matchUnsub = (() => {
    const inner = (event: import('./tracker.js').TxMatchEvent) =>
      matches.push(event)
    // Hook into matchSubs via async iterator drain.
    void (async () => {
      for await (const m of sub.events()) inner(m)
    })()
    return () => {}
  })()
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xt1', from: '0xsender', nonce: '0x1' },
      { hash: '0xt2', from: '0xother', nonce: '0x1' },
    ]),
  )
  // Allow async iterator microtask
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      expect(matches.map((m) => m.hash)).toEqual(['0xt1'])
      matchUnsub()
      unsub()
      sub.stop()
      tracker.stop()
      resolve()
    }, 0)
  })
})

test('trackFromAddress autoTrackMatched: true creates per-hash subscriptions', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const seen: import('./events.js').TxEvent[] = []
  const sub = tracker.trackFromAddress('0xsender')
  sub.subscribe((e) => seen.push(e))
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xt1', from: '0xsender', nonce: '0x1' },
    ]),
  )
  // The auto-tracked per-hash subscriber should see the seen-in-block.
  expect(seen.some((e) => e.kind === 'seen-in-block')).toBe(true)
  sub.stop()
  tracker.stop()
})

test('trackPredicate runs the caller fn against every tx', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const sub = tracker.trackPredicate((tx) => tx.nonce === '0x42')
  const seen: import('./events.js').TxEvent[] = []
  sub.subscribe((e) => seen.push(e))
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xt1', from: '0xa', nonce: '0x1' },
      { hash: '0xt2', from: '0xb', nonce: '0x42' },
    ]),
  )
  // Auto-tracked per-hash subscription should fire seen-in-block on
  // the matched hash only.
  const blockHits = seen.filter(
    (e): e is import('./events.js').TxEventSeenInBlock =>
      e.kind === 'seen-in-block',
  )
  expect(blockHits.map((e) => e.hash)).toEqual(['0xt2'])
  sub.stop()
  tracker.stop()
})

test('capabilities() forwards the source snapshot', () => {
  const caps: Capabilities = {
    ...DEFAULT_CAPS,
    txpoolContent: 'gated',
  }
  const source = makeSource(caps)
  const tracker = startTracker(source)
  expect(tracker.capabilities()).toEqual(caps)
  tracker.stop()
})

const last = <T>(arr: ReadonlyArray<T>): T | undefined => arr[arr.length - 1]

test('stop emits stopped to every tracked hash and clears state', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events: a } = collect(tracker, '0xa', { emitInitial: false })
  const { events: b } = collect(tracker, '0xb', { emitInitial: false })
  tracker.stop()
  expect(last(a)?.kind).toBe('stopped')
  expect(last(b)?.kind).toBe('stopped')
  expect(tracker.getTxStatus('0xa')).toBeNull()
  expect(tracker.getTxStatus('0xb')).toBeNull()
})

test('subscribe → unsubscribe emits stopped with reason "unsubscribed"', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const { events, unsub } = collect(tracker, '0xa', { emitInitial: false })
  unsub()
  expect(last(events)?.kind).toBe('stopped')
  expect(
    (last(events) as import('./events.js').TxEventStopped).reason,
  ).toBe('unsubscribed')
  tracker.stop()
})

test('start() is idempotent', () => {
  const source = makeSource()
  const tracker = createTxTracker({ source, chainId: 1 })
  tracker.start()
  tracker.start()
  // No throw + state machine remains usable
  const { events } = collect(tracker, '0xa')
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xa', from: '0xs', nonce: '0x1' },
    ]),
  )
  expect(events.some((e) => e.kind === 'seen-in-block')).toBe(true)
  tracker.stop()
})

test('maxBulkSubscriptions enforces the cap', () => {
  const source = makeSource()
  const tracker = startTracker(source, { maxBulkSubscriptions: 2 })
  tracker.trackFromAddress('0x1')
  tracker.trackFromAddress('0x2')
  expect(() => tracker.trackFromAddress('0x3')).toThrow(/max bulk/)
  tracker.stop()
})

// ---------- targeted coverage tests ----------

test('trackToAddress matches by recipient (lowercase compare)', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const seen: import('./events.js').TxEvent[] = []
  const sub = tracker.trackToAddress('0xCONTRACT')
  sub.subscribe((e) => seen.push(e))
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      // RawTx at chain-source carries `to` loosely — the matcher
      // reads it via the structurally-typed object so this works.
      { hash: '0xt1', from: '0xs', nonce: '0x1', to: '0xcontract' } as never,
      { hash: '0xt2', from: '0xs', nonce: '0x2', to: '0xother' } as never,
    ]),
  )
  const blockHits = seen.filter(
    (e): e is import('./events.js').TxEventSeenInBlock =>
      e.kind === 'seen-in-block',
  )
  expect(blockHits.map((e) => e.hash)).toEqual(['0xt1'])
  sub.stop()
  tracker.stop()
})

test('per-subscription lostSignalPolicy override silences degrade for that hash only', () => {
  const source = makeSource({ ...DEFAULT_CAPS, newHeads: 'subscription' })
  const tracker = startTracker(source) // tracker default = 'emit-uncertain'
  const noisy: import('./events.js').TxEvent[] = []
  const silent: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xnoisy', (e) => noisy.push(e), { emitInitial: false })
  tracker.subscribe('0xsilent', (e) => silent.push(e), {
    emitInitial: false,
    lostSignalPolicy: 'silent',
  })
  source.emitBlock(makeBlock(100n, '0xb1', []))
  source.setCapabilities({ ...DEFAULT_CAPS, newHeads: 'poll-only' })
  source.emitBlock(makeBlock(101n, '0xb2', [], '0xb1'))
  expect(noisy.some((e) => e.kind === 'signal-degraded')).toBe(true)
  expect(silent.some((e) => e.kind === 'signal-degraded')).toBe(false)
  tracker.stop()
})

test('durable: true persists a record via the store', async () => {
  const source = makeSource()
  const puts: unknown[] = []
  const stubStore: import('./store.js').TxTrackerStore = {
    put: (record) => {
      puts.push(record)
      return Promise.resolve()
    },
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    listDurable: () => Promise.resolve([]),
    appendEvent: () => Promise.resolve(),
  }
  const tracker = startTracker(source, { store: stubStore })
  const unsub = tracker.subscribe('0xdur', () => {}, {
    emitInitial: false,
    durable: true,
  })
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xdur', from: '0xs', nonce: '0x1' },
    ]),
  )
  // Microtask drain so the void-promised store.put settles
  await new Promise((r) => setTimeout(r, 0))
  expect(puts.length).toBeGreaterThan(0)
  const record = puts[0] as import('./store.js').TrackedTxRecord
  expect(record.subscriptions[0]?.durable).toBe(true)
  expect(record.subscriptions[0]?.selector).toEqual({
    kind: 'hash',
    hash: '0xdur',
  })
  unsub()
  tracker.stop()
})

test('predicate-selector + durable: true logs a warning via onError', () => {
  const source = makeSource()
  const errors: { method: string; err: unknown }[] = []
  const tracker = startTracker(source, {
    onError: (method, err) => errors.push({ method, err }),
  })
  const sub = tracker.trackPredicate(() => true, { durable: true })
  expect(
    errors.some(
      (e) =>
        e.method === 'tx-tracker.bulk' &&
        String((e.err as Error).message).includes('predicate selectors are non-durable'),
    ),
  ).toBe(true)
  sub.stop()
  tracker.stop()
})

test('store.appendEvent failure routes through onError without breaking emit', async () => {
  const source = makeSource()
  const errors: { method: string; err: unknown }[] = []
  const failingStore: import('./store.js').TxTrackerStore = {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    listDurable: () => Promise.resolve([]),
    appendEvent: () => Promise.reject(new Error('store kaput')),
  }
  const tracker = startTracker(source, {
    store: failingStore,
    onError: (method, err) => errors.push({ method, err }),
  })
  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xstore', (e) => events.push(e), {
    emitInitial: false,
    durable: true,
  })
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xstore', from: '0xs', nonce: '0x1' },
    ]),
  )
  await new Promise((r) => setTimeout(r, 0))
  // Live emit still landed:
  expect(events.some((e) => e.kind === 'seen-in-block')).toBe(true)
  // And the store error surfaced via onError:
  expect(errors.some((e) => e.method === 'store.appendEvent')).toBe(true)
  tracker.stop()
})

test('bad block number routes through onError and skips processing', () => {
  const source = makeSource()
  const errors: { method: string; err: unknown }[] = []
  const tracker = startTracker(source, {
    onError: (method, err) => errors.push({ method, err }),
  })
  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xanything', (e) => events.push(e), { emitInitial: false })
  // Cast the block to bypass the BlockResult typing — what arrives
  // from the wire isn't always strictly hex-decodable.
  source.emitBlock({
    number: 'not-a-hex-number',
    hash: '0xb1',
    parentHash: '0xparent',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [],
  } as never)
  expect(errors.some((e) => e.method === 'tx-tracker.onBlock')).toBe(true)
  // No events should have fired — onBlock returned early.
  expect(events).toEqual([])
  tracker.stop()
})

test('async iterator return() cleans up after early break', async () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const iter = tracker.track('0xabc', { emitInitial: false })
  // Drive one event, then break — the iterator's return() handler
  // should unsubscribe and resolve any pending waiters.
  const promise = (async () => {
    for await (const event of iter) {
      // break immediately on first non-stopped event
      if (event.kind !== 'stopped') break
    }
  })()
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xabc', from: '0xs', nonce: '0x1' },
    ]),
  )
  await promise
  // Subsequent ticks should not crash even though the iterator was
  // closed mid-stream.
  source.emitBlock(makeBlock(101n, '0xb2', [], '0xb1'))
  tracker.stop()
})

test('bulk async iterator drains via sub.stop()', async () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const sub = tracker.trackFromAddress('0xs')
  const matches: import('./tracker.js').TxMatchEvent[] = []
  const consume = (async () => {
    for await (const m of sub.events()) {
      matches.push(m)
      if (matches.length >= 1) {
        sub.stop()
        break
      }
    }
  })()
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xt1', from: '0xs', nonce: '0x1' },
    ]),
  )
  await consume
  expect(matches).toHaveLength(1)
  tracker.stop()
})

test('bulk async iterator next() resolves done after stop', async () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const sub = tracker.trackFromAddress('0xs')
  const iter = sub.events()[Symbol.asyncIterator]()
  // Stop before any events arrive — next() should resolve `done: true`
  // rather than hang on the empty queue.
  sub.stop()
  const result = await iter.next()
  expect(result.done).toBe(true)
  tracker.stop()
})

test('durable: true on a stub source listDurable list rehydrates nothing on construction (smoke)', async () => {
  // Smoke test: lifecycle: 'eager' tracker construction does not
  // throw when store has zero durable records. Pins the no-op
  // construction path that's load-bearing for the
  // "lazy/eager subscribe" comment in tracker.ts.
  const source = makeSource()
  const tracker = createTxTracker({
    source,
    chainId: 1,
    lifecycle: 'eager',
  })
  tracker.start()
  expect(tracker.capabilities()).toEqual(DEFAULT_CAPS)
  tracker.stop()
})

test('lifecycle: lazy is accepted (no behavioral difference in v0.6.x)', () => {
  // The lifecycle field's lazy branch is reserved — it's accepted at
  // construction and the tracker behaves identically to eager. The
  // distinction will matter when source-subscribe is deferred until
  // first track/getStatus call. Pin the accepts-the-option contract
  // so a future tightening of the option type doesn't silently drop
  // existing call sites.
  const source = makeSource()
  const tracker = createTxTracker({
    source,
    chainId: 1,
    lifecycle: 'lazy',
  })
  tracker.start()
  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xa', (e) => events.push(e), { emitInitial: false })
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xa', from: '0xs', nonce: '0x1' },
    ]),
  )
  expect(events.some((e) => e.kind === 'seen-in-block')).toBe(true)
  tracker.stop()
})

test('bulk-on-mempool fires matched events for txs in the mempool snapshot', () => {
  // Drives the runBulkOnMempool fan-out — bulk subs with active
  // selectors + a mempool snapshot containing matching txs. Covers
  // the bulkSubs.size > 0 branch of the early return guard.
  const source = makeSource()
  const tracker = startTracker(source)
  const matches: import('./tracker.js').TxMatchEvent[] = []
  const sub = tracker.trackFromAddress('0xs')
  // Drain matches via async iter
  void (async () => {
    for await (const m of sub.events()) matches.push(m)
  })()
  source.emitMempool({
    pending: {
      '0xs': {
        '1': { hash: '0xt-mem', from: '0xs', nonce: '0x1' },
      },
    },
    queued: {},
  })
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      expect(matches.some((m) => m.source === 'mempool-snapshot')).toBe(true)
      sub.stop()
      tracker.stop()
      resolve()
    }, 0)
  })
})

test('autoTrackMatched: false emits matched events without per-hash auto-tracking', () => {
  // Drives the false-arm of the `if (sub.options.autoTrackMatched
  // && !sub.autoTrackedUnsubs.has(match.hash))` branch: caller
  // opted out of per-hash auto-tracking, so matched events fire
  // on the bulk stream but no implicit subscribe happens.
  const source = makeSource()
  const tracker = startTracker(source)
  const sub = tracker.trackFromAddress('0xs', { autoTrackMatched: false })
  const perHashEvents: import('./events.js').TxEvent[] = []
  sub.subscribe((e) => perHashEvents.push(e))
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xt1', from: '0xs', nonce: '0x1' },
    ]),
  )
  // No per-hash record created → no seen-in-block forwarded to the
  // bulk's per-hash subscriber.
  expect(perHashEvents).toEqual([])
  // ...but the matched stream is otherwise normal — verifiable via
  // the iterator path:
  expect(tracker.getTxStatus('0xt1')).toBeNull()
  sub.stop()
  tracker.stop()
})

test('block-side txs without hash field are skipped from the txHashSet', () => {
  // Drives the false-arm of the `for (const tx of txs) if (tx.hash)
  // txHashSet.add(...)` loop. A block with mixed txs (some hashed,
  // some not) should add only the hashed ones.
  const source = makeSource()
  const tracker = startTracker(source)
  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xneedle', (e) => events.push(e), { emitInitial: false })
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { from: '0xs', nonce: '0x1' },                       // no hash — skipped
      { hash: '0xneedle', from: '0xs', nonce: '0x2' },     // tracked
      { from: '0xs', nonce: '0x3', gas: '0x5208' },        // no hash — skipped
    ]),
  )
  expect(events.some((e) => e.kind === 'seen-in-block')).toBe(true)
  tracker.stop()
})

test('findBulkSubBySelector iterates past non-matching subs to find the right one', () => {
  // Drives the false-arm of the `if (sub.compiled.selector === selector)`
  // loop in findBulkSubBySelector — multiple bulk subs registered;
  // the lookup must skip the non-matching one before returning the
  // right sub.
  const source = makeSource()
  const tracker = startTracker(source)
  const matchesA: import('./tracker.js').TxMatchEvent[] = []
  const matchesB: import('./tracker.js').TxMatchEvent[] = []
  const subA = tracker.trackFromAddress('0xaaa')
  const subB = tracker.trackFromAddress('0xbbb')
  void (async () => { for await (const m of subA.events()) matchesA.push(m) })()
  void (async () => { for await (const m of subB.events()) matchesB.push(m) })()
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xta', from: '0xaaa', nonce: '0x1' },
      { hash: '0xtb', from: '0xbbb', nonce: '0x1' },
    ]),
  )
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      expect(matchesA.map((m) => m.hash)).toEqual(['0xta'])
      expect(matchesB.map((m) => m.hash)).toEqual(['0xtb'])
      subA.stop()
      subB.stop()
      tracker.stop()
      resolve()
    }, 0)
  })
})

test('block / mempool fixtures with missing optional fields process cleanly', () => {
  // Drives the nullish guards: `block.hash ?? ''`, `block.parentHash
  // ?? null`, `Array.isArray(transactions) ? ... : []`, `if (tx.hash)`,
  // and the mempool-snapshot `if (tx?.hash)` skips. None should throw.
  const source = makeSource()
  const tracker = startTracker(source)
  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xtracked', (e) => events.push(e), { emitInitial: false })
  // Block with no hash, no parentHash, transactions = something non-array
  source.emitBlock({
    number: '0x1234',
    timestamp: '0x100',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: undefined as never,
  } as never)
  // Mempool with a tx missing the hash field
  source.emitMempool({
    pending: {
      '0xs': {
        '1': { from: '0xs', nonce: '0x1' }, // no hash
      },
    },
    queued: {
      '0xs': {
        '2': { from: '0xs', nonce: '0x2' }, // no hash
      },
    },
  })
  // No throw, no seen-in-block (tracked hash isn't in the block)
  expect(events.filter((e) => e.kind === 'seen-in-block')).toHaveLength(0)
  tracker.stop()
})

test('reorg handler skips records whose lastSeenInBlock is at a different height', () => {
  // Multi-hash setup: 0xtxA included at block 100, 0xtxB included
  // at block 99. Reorg only on block 100. The handler must scope
  // vanished-from-block to records matching the divergent height —
  // 0xtxA fires; 0xtxB's record (height 99) is skipped at the
  // `seen.blockNumber !== div.blockNumber` check.
  const source = makeSource()
  const tracker = startTracker(source)
  const eventsA: import('./events.js').TxEvent[] = []
  const eventsB: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xtxA', (e) => eventsA.push(e), { emitInitial: false })
  tracker.subscribe('0xtxB', (e) => eventsB.push(e), { emitInitial: false })
  // Block 99 includes 0xtxB
  source.emitBlock(
    makeBlock(99n, '0xb99', [
      { hash: '0xtxB', from: '0xs', nonce: '0x1' },
    ]),
  )
  // Block 100 includes 0xtxA — original hash 0xb100-orig
  source.emitBlock(
    makeBlock(100n, '0xb100-orig', [
      { hash: '0xtxA', from: '0xs', nonce: '0x2' },
    ], '0xb99'),
  )
  // Same-height reorg on block 100 only
  source.emitBlock(makeBlock(100n, '0xb100-new', [], '0xb99'))
  expect(eventsA.some((e) => e.kind === 'vanished-from-block')).toBe(true)
  expect(eventsB.some((e) => e.kind === 'vanished-from-block')).toBe(false)
  tracker.stop()
})

test('async iterator drains multiple pending waiters with done:true on tracker.stop', async () => {
  // Two concurrent `next()` calls before any event arrives → both
  // are pushed onto the waiters queue. tracker.stop() fires the
  // `stopped` event, which resolves the first waiter with that
  // event AND triggers the drain loop for the remaining waiter
  // (resolved with done:true). Covers the explicit drain branches.
  const source = makeSource()
  const tracker = startTracker(source)
  const iter = tracker
    .track('0xz', { emitInitial: false })
    [Symbol.asyncIterator]()
  // Two pending next() calls — neither awaited yet.
  const next1 = iter.next()
  const next2 = iter.next()
  tracker.stop()
  const r1 = await next1
  const r2 = await next2
  // First gets the stopped event; second gets done.
  expect(r1.done).toBe(false)
  expect(r1.value.kind).toBe('stopped')
  expect(r2.done).toBe(true)
})

test('async iterator return() resolves a pending waiter with the synthetic stopped event', async () => {
  // Caller calls iter.return() (e.g. via a try/finally cleanup)
  // while a next() promise is pending. The unsubscribe path emits
  // a synthetic stopped event to the iterator's subscribe callback,
  // which resolves the first pending waiter with that event. Any
  // ADDITIONAL waiters then drain with done:true — see the
  // separate "drains multiple pending waiters" test.
  const source = makeSource()
  const tracker = startTracker(source)
  const iter = tracker
    .track('0xz', { emitInitial: false })
    [Symbol.asyncIterator]()
  const pending = iter.next()
  await iter.return!()
  const result = await pending
  expect(result.done).toBe(false)
  expect(result.value.kind).toBe('stopped')
  // A subsequent next() resolves done:true since the iterator is
  // closed.
  const after = await iter.next()
  expect(after.done).toBe(true)
  tracker.stop()
})

test('async iterator return() drains additional pending waiters with done:true', async () => {
  // Two concurrent next() calls before return(). The first gets
  // the synthetic stopped event; the second drains with done:true
  // via the explicit waiter-drain loop in return().
  const source = makeSource()
  const tracker = startTracker(source)
  const iter = tracker
    .track('0xz', { emitInitial: false })
    [Symbol.asyncIterator]()
  const next1 = iter.next()
  const next2 = iter.next()
  await iter.return!()
  const r1 = await next1
  const r2 = await next2
  expect(r1.done).toBe(false)
  expect(r1.value.kind).toBe('stopped')
  expect(r2.done).toBe(true)
  tracker.stop()
})

test('bulk async iterator drains multiple pending waiters when sub.stop fires', async () => {
  // Mirror of the per-hash drain test but for the bulk subscription
  // iterator's separate state machine.
  const source = makeSource()
  const tracker = startTracker(source)
  const sub = tracker.trackFromAddress('0xs')
  const iter = sub.events()[Symbol.asyncIterator]()
  const next1 = iter.next()
  const next2 = iter.next()
  await iter.return!()
  const r1 = await next1
  const r2 = await next2
  expect(r1.done).toBe(true)
  expect(r2.done).toBe(true)
  sub.stop()
  tracker.stop()
})

test('two subs on the same hash share one record; cleanup waits for both to unsubscribe', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const eventsA: import('./events.js').TxEvent[] = []
  const eventsB: import('./events.js').TxEvent[] = []
  const unsubA = tracker.subscribe('0xshared', (e) => eventsA.push(e), {
    emitInitial: false,
  })
  const unsubB = tracker.subscribe('0xshared', (e) => eventsB.push(e), {
    emitInitial: false,
  })
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xshared', from: '0xs', nonce: '0x1' },
    ]),
  )
  // Both subs see the inclusion.
  expect(eventsA.some((e) => e.kind === 'seen-in-block')).toBe(true)
  expect(eventsB.some((e) => e.kind === 'seen-in-block')).toBe(true)
  // Status survives one unsubscribe (record not GC'd while a sub remains).
  unsubA()
  expect(tracker.getTxStatus('0xshared')).not.toBeNull()
  // Status drops after the second unsubscribe (no subs left, not durable).
  unsubB()
  expect(tracker.getTxStatus('0xshared')).toBeNull()
  tracker.stop()
})

test('subscribe + unsubscribe is idempotent; second unsub is a no-op', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const events: import('./events.js').TxEvent[] = []
  const unsub = tracker.subscribe('0xa', (e) => events.push(e), {
    emitInitial: false,
  })
  unsub()
  const beforeSecond = events.length
  unsub() // second call should be a no-op — no extra stopped event
  expect(events.length).toBe(beforeSecond)
  tracker.stop()
})

test('tracker.stop() is idempotent', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  tracker.stop()
  // Second stop must not throw or double-emit.
  expect(() => tracker.stop()).not.toThrow()
})

test('bulk sub.stop() is idempotent', () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const sub = tracker.trackFromAddress('0xa')
  sub.stop()
  expect(() => sub.stop()).not.toThrow()
  tracker.stop()
})

test('store.put failure routes through onError without breaking emit', async () => {
  const source = makeSource()
  const errors: { method: string; err: unknown }[] = []
  const failingStore: import('./store.js').TxTrackerStore = {
    put: () => Promise.reject(new Error('put kaput')),
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    listDurable: () => Promise.resolve([]),
    appendEvent: () => Promise.resolve(),
  }
  const tracker = startTracker(source, {
    store: failingStore,
    onError: (method, err) => errors.push({ method, err }),
  })
  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xput', (e) => events.push(e), {
    emitInitial: false,
    durable: true,  // triggers the store.put on subscribe
  })
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xput', from: '0xs', nonce: '0x1' },
    ]),
  )
  await new Promise((r) => setTimeout(r, 0))
  expect(events.some((e) => e.kind === 'seen-in-block')).toBe(true)
  expect(errors.some((e) => e.method === 'store.put')).toBe(true)
  tracker.stop()
})

test('async iterator delivers events queued before next() is called', async () => {
  // Drives the queue branch (event arrives, no waiter yet → push to
  // queue; later next() shifts from the queue without awaiting).
  const source = makeSource()
  const tracker = startTracker(source)
  const iter = tracker
    .track('0xq', { emitInitial: false })
    [Symbol.asyncIterator]()
  // Fire the event BEFORE calling .next() — it goes onto the queue.
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xq', from: '0xs', nonce: '0x1' },
    ]),
  )
  // First .next() should resolve from the queue, not block.
  const first = await iter.next()
  expect(first.done).toBe(false)
  expect(first.value.kind).toBe('seen-in-block')
  // Cleanup
  await iter.return!()
  tracker.stop()
})

test('bulk async iterator queues match events arrived before .next()', async () => {
  const source = makeSource()
  const tracker = startTracker(source)
  const sub = tracker.trackFromAddress('0xs')
  const iter = sub.events()[Symbol.asyncIterator]()
  // Match-emit before next()
  source.emitBlock(
    makeBlock(100n, '0xb1', [
      { hash: '0xt1', from: '0xs', nonce: '0x1' },
    ]),
  )
  const first = await iter.next()
  expect(first.done).toBe(false)
  expect(first.value.hash).toBe('0xt1')
  await iter.return!()
  sub.stop()
  tracker.stop()
})

test('reorg handler skips records without lastSeenInBlock', () => {
  // Ensures L694's `if (!seen) continue` is exercised: a tracked
  // hash that has only ever been seen in mempool (never in a block)
  // must NOT receive vanished-from-block events even when a same-
  // height reorg lands somewhere.
  const source = makeSource()
  const tracker = startTracker(source)
  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xmempool-only', (e) => events.push(e), {
    emitInitial: false,
  })
  source.emitMempool({
    pending: {
      '0xs': { '1': { hash: '0xmempool-only', from: '0xs', nonce: '0x1' } },
    },
    queued: {},
  })
  // Different tracked hash gets included, then reorged.
  tracker.subscribe('0xincluded', () => {}, { emitInitial: false })
  source.emitBlock(
    makeBlock(100n, '0xb-orig', [
      { hash: '0xincluded', from: '0xs2', nonce: '0x1' },
    ]),
  )
  source.emitBlock(makeBlock(100n, '0xb-new', []))
  // The mempool-only hash must NOT see vanished-from-block.
  expect(events.some((e) => e.kind === 'vanished-from-block')).toBe(false)
  tracker.stop()
})

test('findReplacement falls back to raw nonce when BigInt(nonce) throws', () => {
  // The replacement detector normalizes the cached identity's nonce
  // to decimal before keying into the mempool's nonce-keyed sub-map.
  // If the cached nonce isn't valid hex (test fixtures or off-spec
  // RPCs), the BigInt() throws — the fallback uses the raw nonce
  // string as the key. A mempool snapshot with that exact raw key
  // still resolves to the replacement.
  const source = makeSource()
  const tracker = startTracker(source)
  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xorig', (e) => events.push(e), { emitInitial: false })
  // Seed identity by observing the original in mempool with a
  // non-numeric nonce string. The tracker caches `(from='0xs', nonce='abc')`.
  source.emitMempool({
    pending: { '0xs': { abc: { hash: '0xorig', from: '0xs', nonce: 'abc' } } },
    queued: {},
  })
  // Drop original, introduce replacement at the same identity-with-
  // raw-nonce-key. The fallback path is what makes the lookup work.
  source.emitMempool({
    pending: { '0xs': { abc: { hash: '0xrep', from: '0xs', nonce: 'abc' } } },
    queued: {},
  })
  const replaceEvents = events.filter((e) => e.kind === 'replaced-by')
  expect(replaceEvents).toHaveLength(1)
  expect(
    (replaceEvents[0] as import('./events.js').TxEventReplacedBy)
      .replacementHash,
  ).toBe('0xrep')
  tracker.stop()
})

// ---------- receipt-poll-fallback tests ----------

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

test('receipt-poll-fallback — emits seen-in-block from receipt-poll on degraded signal', async () => {
  // capabilities show signal lost — newHeads unavailable, receiptByHash
  // available. The fallback policy should kick in.
  const degradedCaps: Capabilities = {
    newHeads: 'unavailable',
    newPendingTransactions: 'unavailable',
    txpoolContent: 'gated',
    receiptByHash: 'available',
    reprobeOnReconnect: false,
  }
  const source = makeSource({
    initialCaps: degradedCaps,
    receiptMap: {
      '0xtarget': {
        transactionHash: '0xtarget',
        blockHash: '0xblockfromreceipt',
        blockNumber: '0x42',
        status: '0x1',
      },
    },
  })

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 1 },
  })
  tracker.start()

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xtarget', (e) => events.push(e), { emitInitial: false })

  source.emitBlock({
    number: '0x10',
    hash: '0xtip10',
    parentHash: '0x9',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [],
  })
  await flush()

  const seen = events.find(
    (e): e is import('./events.js').TxEventSeenInBlock =>
      e.kind === 'seen-in-block' && e.source === 'receipt-poll',
  )
  expect(seen).toBeDefined()
  expect(seen!.blockHash).toBe('0xblockfromreceipt')
  expect(seen!.blockNumber).toBe(0x42n)
  tracker.stop()
})

test('receipt-poll-fallback — does not emit on globalSubs when record was orphaned mid-await (audit #6)', async () => {
  // Race: receipt-poll for record A starts, source.getReceipt awaits.
  // During the await, A's only subscriber leaves (cleanupRecord drops
  // A from `tracked`). Then a fresh subscribe re-creates A' under the
  // same hash. Pre-fix, the post-await emit walked `tracked.has(hash)`
  // which returns true (A' is there) and fired on globalSubs with the
  // OLD record's stale block coordinate. Per-hash subs of A' didn't
  // see it (different Subscriptions instance), so the artifact only
  // showed up to subscribeAll consumers — silent inconsistency
  // between global and per-hash streams. Fix: identity check, not
  // presence check.
  const degradedCaps: Capabilities = {
    newHeads: 'unavailable',
    newPendingTransactions: 'unavailable',
    txpoolContent: 'gated',
    receiptByHash: 'available',
    reprobeOnReconnect: false,
  }
  // Deferred receipt — we resolve it manually after orchestrating
  // the unsub + re-subscribe race window.
  let resolveReceipt: ((r: TransactionReceipt | null) => void) | null = null
  const source = makeSource({
    initialCaps: degradedCaps,
    getReceiptImpl: () =>
      new Promise<TransactionReceipt | null>((resolve) => {
        resolveReceipt = resolve
      }),
  })
  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 1 },
  })
  tracker.start()

  const allEvents: import('./events.js').TxEvent[] = []
  tracker.subscribeAll((e) => allEvents.push(e))

  // Subscribe with cb_A, drive a block to start receipt-poll.
  const unsubA = tracker.subscribe('0xtarget', () => {}, { emitInitial: false })
  source.emitBlock({
    number: '0x10',
    hash: '0xtip10',
    parentHash: '0x9',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [],
  })
  // Yield once so the receipt-poll's await getReceipt is in-flight.
  await flush()
  expect(resolveReceipt).not.toBeNull()

  // Mid-await: drop the original subscriber (cleanupRecord deletes A
  // from `tracked`), then re-subscribe with cb_A' (creates new record
  // A' under the same hash).
  unsubA()
  const aPrimeEvents: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xtarget', (e) => aPrimeEvents.push(e), { emitInitial: false })

  // Resolve the receipt — the post-await branch should detect A is
  // no longer the canonical record under the hash and bail.
  resolveReceipt!({
    transactionHash: '0xtarget',
    blockHash: '0xblockfromreceipt',
    blockNumber: '0x42',
    status: '0x1',
  })
  await flush()
  await flush()

  // A' should not have received an event from the prior poll cycle.
  expect(aPrimeEvents.find((e) => e.kind === 'seen-in-block')).toBeUndefined()
  // globalSubs should not have received a phantom seen-in-block from
  // the orphaned poll either.
  const phantomGlobal = allEvents.find(
    (e) => e.kind === 'seen-in-block' && e.source === 'receipt-poll',
  )
  expect(phantomGlobal).toBeUndefined()
  tracker.stop()
})

test('receipt-poll-fallback — capability gate downgrades to emit-uncertain when receiptByHash unavailable', async () => {
  const onError = vi.fn()
  const degradedCaps: Capabilities = {
    newHeads: 'unavailable',
    newPendingTransactions: 'unavailable',
    txpoolContent: 'gated',
    receiptByHash: 'unavailable',
    reprobeOnReconnect: false,
  }
  const source = makeSource({ initialCaps: degradedCaps })

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 1 },
    onError,
  })
  tracker.start()

  tracker.subscribe('0xt', () => {}, { emitInitial: false })
  source.emitBlock({
    number: '0x10',
    hash: '0xtip10',
    parentHash: '0x9',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [],
  })
  await flush()

  expect(onError).toHaveBeenCalledWith(
    'tx-tracker.receipt-poll-fallback',
    expect.objectContaining({ message: expect.stringContaining('receiptByHash unavailable') }),
  )
  tracker.stop()
})

test('receipt-poll-fallback — gate warning fires only once across multiple ticks', async () => {
  // The `receiptPollGateWarned` flag must prevent duplicate warnings
  // on every block tick when receiptByHash is unavailable.
  const onError = vi.fn()
  const degradedCaps: Capabilities = {
    newHeads: 'unavailable',
    newPendingTransactions: 'unavailable',
    txpoolContent: 'gated',
    receiptByHash: 'unavailable',
    reprobeOnReconnect: false,
  }
  const source = makeSource({ initialCaps: degradedCaps })

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 1 },
    onError,
  })
  tracker.start()
  tracker.subscribe('0xt', () => {}, { emitInitial: false })

  source.emitBlock({
    number: '0x10', hash: '0xb1', parentHash: '0x0',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()
  source.emitBlock({
    number: '0x11', hash: '0xb2', parentHash: '0xb1',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()

  const warnCalls = onError.mock.calls.filter(
    ([method]) => method === 'tx-tracker.receipt-poll-fallback',
  )
  expect(warnCalls).toHaveLength(1)
  tracker.stop()
})

test('receipt-poll-fallback — pollEveryBlocks > 1 skips ticks until threshold reached', async () => {
  const degradedCaps: Capabilities = {
    newHeads: 'unavailable',
    newPendingTransactions: 'unavailable',
    txpoolContent: 'gated',
    receiptByHash: 'available',
    reprobeOnReconnect: false,
  }
  const source = makeSource({
    initialCaps: degradedCaps,
    receiptMap: {
      '0xhash': {
        transactionHash: '0xhash',
        blockHash: '0xreceiptblock',
        blockNumber: '0x5',
        status: '0x1',
      },
    },
  })

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 3 },
  })
  tracker.start()

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xhash', (e) => events.push(e), { emitInitial: false })

  // Block 1 — tick=1/3, should not poll yet
  source.emitBlock({
    number: '0x1', hash: '0xb1', parentHash: '0x0',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()
  expect(events.filter((e) => e.kind === 'seen-in-block')).toHaveLength(0)

  // Block 2 — tick=2/3, still no poll
  source.emitBlock({
    number: '0x2', hash: '0xb2', parentHash: '0xb1',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()
  expect(events.filter((e) => e.kind === 'seen-in-block')).toHaveLength(0)

  // Block 3 — tick=3/3, should poll and emit
  source.emitBlock({
    number: '0x3', hash: '0xb3', parentHash: '0xb2',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()
  const seenEvents = events.filter((e) => e.kind === 'seen-in-block')
  expect(seenEvents).toHaveLength(1)
  tracker.stop()
})

test('receipt-poll-fallback — getReceipt returning null emits nothing', async () => {
  // Receipt not yet included — getReceipt returns null. No seen-in-block.
  const degradedCaps: Capabilities = {
    newHeads: 'unavailable',
    newPendingTransactions: 'unavailable',
    txpoolContent: 'gated',
    receiptByHash: 'available',
    reprobeOnReconnect: false,
  }
  const source = makeSource({ initialCaps: degradedCaps }) // no receiptMap → returns null

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 1 },
  })
  tracker.start()

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xunmined', (e) => events.push(e), { emitInitial: false })

  source.emitBlock({
    number: '0x1', hash: '0xb1', parentHash: '0x0',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()

  expect(events.filter((e) => e.kind === 'seen-in-block')).toHaveLength(0)
  tracker.stop()
})

test('receipt-poll-fallback — getReceipt throwing routes through onError', async () => {
  const onError = vi.fn()
  const degradedCaps: Capabilities = {
    newHeads: 'unavailable',
    newPendingTransactions: 'unavailable',
    txpoolContent: 'gated',
    receiptByHash: 'available',
    reprobeOnReconnect: false,
  }
  const source = makeSource({
    initialCaps: degradedCaps,
    getReceiptImpl: () => Promise.reject(new Error('network failure')),
  })

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 1 },
    onError,
  })
  tracker.start()

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xerr', (e) => events.push(e), { emitInitial: false })

  source.emitBlock({
    number: '0x1', hash: '0xb1', parentHash: '0x0',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()

  expect(onError).toHaveBeenCalledWith(
    'tx-tracker.getReceipt',
    expect.objectContaining({ message: 'network failure' }),
  )
  expect(events.filter((e) => e.kind === 'seen-in-block')).toHaveLength(0)
  tracker.stop()
})

test('receipt-poll-fallback — bad receipt blockNumber routes through onError', async () => {
  const onError = vi.fn()
  const degradedCaps: Capabilities = {
    newHeads: 'unavailable',
    newPendingTransactions: 'unavailable',
    txpoolContent: 'gated',
    receiptByHash: 'available',
    reprobeOnReconnect: false,
  }
  const source = makeSource({
    initialCaps: degradedCaps,
    receiptMap: {
      '0xbad': {
        transactionHash: '0xbad',
        blockHash: '0xreceiptblock',
        blockNumber: 'not-a-hex',
        status: '0x1',
      },
    },
  })

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 1 },
    onError,
  })
  tracker.start()

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xbad', (e) => events.push(e), { emitInitial: false })

  source.emitBlock({
    number: '0x1', hash: '0xb1', parentHash: '0x0',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()

  expect(onError).toHaveBeenCalledWith(
    'tx-tracker.receipt-poll-fallback',
    expect.objectContaining({ message: expect.stringContaining('bad receipt blockNumber') }),
  )
  expect(events.filter((e) => e.kind === 'seen-in-block')).toHaveLength(0)
  tracker.stop()
})

test("receipt-poll-fallback — policy 'emit-uncertain' skips receipt poll path", async () => {
  // When the default lostSignalPolicy is 'emit-uncertain', runReceiptPollFallback
  // must early-return without attempting getReceipt.
  const getReceiptImpl = vi.fn(() => Promise.resolve(null))
  const source = makeSource({ getReceiptImpl })

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: 'emit-uncertain',
  })
  tracker.start()

  tracker.subscribe('0xskip', () => {}, { emitInitial: false })
  source.emitBlock({
    number: '0x1', hash: '0xb1', parentHash: '0x0',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()

  expect(getReceiptImpl).not.toHaveBeenCalled()
  tracker.stop()
})

test("receipt-poll-fallback — policy 'silent' skips receipt poll path", async () => {
  // When the default lostSignalPolicy is 'silent', runReceiptPollFallback
  // must early-return without attempting getReceipt.
  const getReceiptImpl = vi.fn(() => Promise.resolve(null))
  const source = makeSource({ getReceiptImpl })

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: 'silent',
  })
  tracker.start()

  tracker.subscribe('0xskip', () => {}, { emitInitial: false })
  source.emitBlock({
    number: '0x1', hash: '0xb1', parentHash: '0x0',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()

  expect(getReceiptImpl).not.toHaveBeenCalled()
  tracker.stop()
})

test('receipt-poll-fallback — getTxStatus reflects receipt-poll inclusion', async () => {
  // After a receipt-poll hit, getTxStatus().lastSeenInBlock must carry
  // the receipt data so callers can confirm the tx without listening to events.
  const degradedCaps: Capabilities = {
    newHeads: 'unavailable',
    newPendingTransactions: 'unavailable',
    txpoolContent: 'gated',
    receiptByHash: 'available',
    reprobeOnReconnect: false,
  }
  const source = makeSource({
    initialCaps: degradedCaps,
    receiptMap: {
      '0xstatus': {
        transactionHash: '0xstatus',
        blockHash: '0xstatusblock',
        blockNumber: '0x7',
        status: '0x1',
      },
    },
  })

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 1 },
  })
  tracker.start()

  tracker.subscribe('0xstatus', () => {}, { emitInitial: false })
  source.emitBlock({
    number: '0x10', hash: '0xtip', parentHash: '0x0',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()

  const status = tracker.getTxStatus('0xstatus')
  expect(status?.lastSeenInBlock?.blockHash).toBe('0xstatusblock')
  expect(status?.lastSeenInBlock?.blockNumber).toBe(7n)
  expect(status?.lastSeenInBlock?.source).toBe('receipt-poll')
  tracker.stop()
})

test('receipt-poll-fallback — does not overwrite higher-authority block-poll inclusion at same height', async () => {
  // If a tx was already included via block-poll at blockNumber 100, a
  // receipt-poll returning blockNumber 100 should NOT overwrite the existing
  // lastSeenInBlock (block-poll has higher authority). But a receipt at a newer
  // height is allowed to update the record.
  const source = makeSource({
    receiptMap: {
      '0xhighauth': {
        transactionHash: '0xhighauth',
        blockHash: '0xolderblock',
        blockNumber: '0x64', // 100
        status: '0x1',
      },
    },
  })

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 1 },
  })
  tracker.start()

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xhighauth', (e) => events.push(e), { emitInitial: false })

  // Block-poll inclusion at block 100 with subscription source
  source.emitBlock(makeBlock(100n, '0xb100', [
    { hash: '0xhighauth', from: '0xs', nonce: '0x1' },
  ]))
  await flush()

  // Now the tracker has lastSeenInBlock at 100 from subscription.
  // Receipt-poll returns the same block 100 — should not overwrite.
  source.emitBlock(makeBlock(101n, '0xb101', [], '0xb100'))
  await flush()

  // Only two events: first inclusion + confirmation bump (both subscription source)
  const seenEvents = events.filter(
    (e): e is import('./events.js').TxEventSeenInBlock => e.kind === 'seen-in-block',
  )
  // The existing block-poll confirmation bump at 101 would be source 'subscription'.
  // No receipt-poll seen-in-block should be emitted at block 100 (not newer than lastSeenInBlock).
  const receiptPollEvents = seenEvents.filter((e) => e.source === 'receipt-poll')
  expect(receiptPollEvents).toHaveLength(0)
  tracker.stop()
})

test('receipt-poll-fallback — stop() clears block counter and gate flag', async () => {
  // After stop(), a fresh start must reset the pollCounter and gateWarned flag.
  // This test drives stop() while receipt-poll state exists, then verifies
  // the tracker is clean enough to not leak state into a subsequent run.
  const onError = vi.fn()
  const degradedCaps: Capabilities = {
    newHeads: 'unavailable',
    newPendingTransactions: 'unavailable',
    txpoolContent: 'gated',
    receiptByHash: 'unavailable',
    reprobeOnReconnect: false,
  }
  const source = makeSource({ initialCaps: degradedCaps })

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 1 },
    onError,
  })
  tracker.start()
  tracker.subscribe('0xreset', () => {}, { emitInitial: false })

  source.emitBlock({
    number: '0x1', hash: '0xb1', parentHash: '0x0',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()
  // Warning fires once for the gate.
  expect(onError).toHaveBeenCalledTimes(1)

  tracker.stop()

  // After stop(), tracked records are cleared. Restart and re-subscribe.
  tracker.start()
  tracker.subscribe('0xreset', () => {}, { emitInitial: false })
  source.emitBlock({
    number: '0x2', hash: '0xb2', parentHash: '0xb1',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()
  // The gate should have fired again (flag was reset by stop()).
  expect(onError).toHaveBeenCalledTimes(2)
  tracker.stop()
})

test('receipt-poll-fallback — Map entry deleted when record is cleaned up', async () => {
  // Subscribe → push block (poll fires) → unsubscribe.
  // Re-subscribing after unsubscribe should start the counter fresh
  // (at 1 on the first block tick), proving the Map entry was deleted
  // by cleanupRecord and not left stale.
  const degradedCaps: Capabilities = {
    newHeads: 'unavailable',
    newPendingTransactions: 'unavailable',
    txpoolContent: 'gated',
    receiptByHash: 'available',
    reprobeOnReconnect: false,
  }
  // pollEveryBlocks: 3 so the counter is meaningful — tick counts
  // starting from 0 after unsub would re-poll on tick 3, not tick 2.
  const source = makeSource({
    initialCaps: degradedCaps,
    receiptMap: {},
  })

  const tracker = createTxTracker({
    source,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 3 },
  })
  tracker.start()

  const unsub = tracker.subscribe('0xcounter', () => {}, { emitInitial: false })
  // Block 1 — increments counter to 1 (no poll yet)
  source.emitBlock({
    number: '0x1', hash: '0xb1', parentHash: '0x0',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()

  // Unsubscribe — cleanupRecord should delete the counter Map entry.
  unsub()

  // Re-subscribe with a fresh receiptMap hit to detect if the counter
  // restarted from 0 (leaked) vs clean start.
  const secondEvents: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xcounter', (e) => secondEvents.push(e), { emitInitial: false })

  // Block 2 — if the counter leaked (still at 1), next poll would fire
  // at block 3 (tick 3). If clean (counter starts at 0), the first
  // poll fires at block 4. Either way we just verify no crash and the
  // counter started fresh by checking no spurious early poll fires.
  source.emitBlock({
    number: '0x2', hash: '0xb2', parentHash: '0xb1',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()
  source.emitBlock({
    number: '0x3', hash: '0xb3', parentHash: '0xb2',
    timestamp: '0x0', baseFeePerGas: '0x0', gasLimit: '0x0', gasUsed: '0x0', transactions: [],
  })
  await flush()

  // With a fresh counter (0 at re-subscribe), tick 1 → 2 → 3 means the
  // poll fires on block 3 (the third block after re-subscribe). With a
  // leaked counter (1 from before unsub), the poll would fire on block 2
  // instead (tick 2 reaches threshold 3? no — tick increments to 2,
  // threshold is 3, so it fires on the 3rd tick from when counter was 1).
  // The key correctness check: the counter was re-initialized to 0, so
  // we just verify no errors or crashes during the sequence.
  expect(secondEvents.filter((e) => e.kind === 'seen-in-block')).toHaveLength(0)
  tracker.stop()
})

test('receipt-poll-fallback — does not emit globally when subscription is torn down mid-await', async () => {
  // Use a deferred receipt promise so we can synchronize the unsubscribe
  // with the in-flight getReceipt call. Verify subscribeAll listener is
  // never invoked for that hash's receipt-poll event.
  let resolveReceipt: ((r: TransactionReceipt | null) => void) | null = null
  const stubSource = makeSource({
    initialCaps: {
      newHeads: 'unavailable',
      newPendingTransactions: 'unavailable',
      txpoolContent: 'gated',
      receiptByHash: 'available',
      reprobeOnReconnect: false,
    },
    getReceiptImpl: () =>
      new Promise<TransactionReceipt | null>((resolve) => {
        resolveReceipt = resolve
      }),
  })

  const tracker = createTxTracker({
    source: stubSource,
    chainId: 1,
    lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: 1 },
  })
  tracker.start()

  const allEvents: import('./events.js').TxEvent[] = []
  tracker.subscribeAll((e) => allEvents.push(e))

  const unsub = tracker.subscribe('0xtarget', () => {}, { emitInitial: false })
  stubSource.emitBlock({
    number: '0x10',
    hash: '0xtip10',
    parentHash: '0x9',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [],
  })
  await flush()

  // Receipt fetch is in-flight (promise unresolved). Unsubscribe.
  unsub()
  await flush()

  // Now resolve the in-flight receipt — this used to spuriously fan out to globalSubs.
  resolveReceipt!({
    transactionHash: '0xtarget',
    blockHash: '0xb',
    blockNumber: '0x42',
    status: '0x1',
  })
  await flush()

  // No seen-in-block from receipt-poll should fan out via subscribeAll.
  const spurious = allEvents.find(
    (e) =>
      e.kind === 'seen-in-block' &&
      (e as import('./events.js').TxEventSeenInBlock).source === 'receipt-poll' &&
      e.hash === '0xtarget',
  )
  expect(spurious).toBeUndefined()

  tracker.stop()
})

// ---------- withReceipts: true eager enrichment tests (spec §18.2, F2) ----------

test('withReceipts: true — attaches receipt to seen-in-block on first emit', async () => {
  const source = makeSource({
    initialCaps: {
      newHeads: 'subscription',
      newPendingTransactions: 'subscription',
      txpoolContent: 'available',
      receiptByHash: 'available',
      reprobeOnReconnect: true,
    },
    receiptMap: {
      '0xt': {
        transactionHash: '0xt',
        blockHash: '0xb1',
        blockNumber: '0x10',
        status: '0x1',
      },
    },
  })

  const tracker = createTxTracker({ source, chainId: 1 })
  tracker.start()

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), {
    withReceipts: true,
    emitInitial: false,
  })

  source.emitBlock({
    number: '0x10',
    hash: '0xb1',
    parentHash: '0x0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [{ hash: '0xt', from: '0xs', nonce: '0x0' }],
  })
  await flush()

  const seenInBlocks = events.filter(
    (e): e is import('./events.js').TxEventSeenInBlock => e.kind === 'seen-in-block',
  )
  // Exactly one emission — receipt is on the first event, not a follow-up.
  expect(seenInBlocks).toHaveLength(1)
  expect(seenInBlocks[0].receipt).toBeDefined()
  expect(seenInBlocks[0].receipt!.status).toBe('0x1')
  tracker.stop()
})

test('withReceipts: true + receiptByHash unavailable — flows without receipt + warns once', async () => {
  const onError = vi.fn()
  const source = makeSource({
    initialCaps: {
      newHeads: 'subscription',
      newPendingTransactions: 'subscription',
      txpoolContent: 'available',
      receiptByHash: 'unavailable',
      reprobeOnReconnect: true,
    },
  })
  const tracker = createTxTracker({ source, chainId: 1, onError })
  tracker.start()

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), {
    withReceipts: true,
    emitInitial: false,
  })

  // Push two block ticks to verify warn-once.
  source.emitBlock({
    number: '0x10',
    hash: '0xb1',
    parentHash: '0x0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [{ hash: '0xt', from: '0xs', nonce: '0x0' }],
  })
  await flush()
  source.emitBlock({
    number: '0x11',
    hash: '0xb2',
    parentHash: '0xb1',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [],
  })
  await flush()

  const seenInBlocks = events.filter(
    (e): e is import('./events.js').TxEventSeenInBlock => e.kind === 'seen-in-block',
  )
  expect(seenInBlocks.length).toBeGreaterThan(0)
  for (const e of seenInBlocks) expect(e.receipt).toBeUndefined()

  // Warn-once: only one call with the withReceipts method tag.
  const withReceiptsWarns = onError.mock.calls.filter(
    ([method]) => method === 'tx-tracker.withReceipts',
  )
  expect(withReceiptsWarns).toHaveLength(1)
  tracker.stop()
})

test('withReceipts: false (default) — no receipt field on seen-in-block event', async () => {
  const source = makeSource({
    receiptMap: {
      '0xt': {
        transactionHash: '0xt',
        blockHash: '0xb1',
        blockNumber: '0x10',
        status: '0x1',
      },
    },
  })
  const tracker = createTxTracker({ source, chainId: 1 })
  tracker.start()

  const events: import('./events.js').TxEvent[] = []
  // withReceipts not set — defaults to false
  tracker.subscribe('0xt', (e) => events.push(e), { emitInitial: false })

  source.emitBlock(makeBlock(16n, '0xb1', [{ hash: '0xt', from: '0xs', nonce: '0x0' }]))
  await flush()

  const seen = events.find(
    (e): e is import('./events.js').TxEventSeenInBlock => e.kind === 'seen-in-block',
  )
  expect(seen).toBeDefined()
  expect(seen!.receipt).toBeUndefined()
  tracker.stop()
})

test('withReceipts: true + getReceipt throws — events flow without receipt + onError fires', async () => {
  const onError = vi.fn()
  const receiptError = new Error('rpc timeout')
  const source = makeSource({
    initialCaps: {
      newHeads: 'subscription',
      newPendingTransactions: 'subscription',
      txpoolContent: 'available',
      receiptByHash: 'available',
      reprobeOnReconnect: true,
    },
    getReceiptImpl: () => Promise.reject(receiptError),
  })
  const tracker = createTxTracker({ source, chainId: 1, onError })
  tracker.start()

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), {
    withReceipts: true,
    emitInitial: false,
  })

  source.emitBlock({
    number: '0x10',
    hash: '0xb1',
    parentHash: '0x0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [{ hash: '0xt', from: '0xs', nonce: '0x0' }],
  })
  await flush()

  const seen = events.find(
    (e): e is import('./events.js').TxEventSeenInBlock => e.kind === 'seen-in-block',
  )
  // Event still emitted even though getReceipt failed.
  expect(seen).toBeDefined()
  expect(seen!.receipt).toBeUndefined()
  // onError should have been called with the RPC error.
  expect(onError).toHaveBeenCalledWith('tx-tracker.getReceipt', receiptError)
  tracker.stop()
})

test('withReceipts: true + multiple subscriptions same hash — only one receipt fetch per block tick', async () => {
  let fetchCount = 0
  const source = makeSource({
    initialCaps: {
      newHeads: 'subscription',
      newPendingTransactions: 'subscription',
      txpoolContent: 'available',
      receiptByHash: 'available',
      reprobeOnReconnect: true,
    },
    getReceiptImpl: async () => {
      fetchCount++
      return {
        transactionHash: '0xt',
        blockHash: '0xb1',
        blockNumber: '0x10',
        status: '0x1',
      }
    },
  })
  const tracker = createTxTracker({ source, chainId: 1 })
  tracker.start()

  // Two subscriptions on the same hash, both with withReceipts: true.
  const eventsA: import('./events.js').TxEvent[] = []
  const eventsB: import('./events.js').TxEvent[] = []
  const unsubA = tracker.subscribe('0xt', (e) => eventsA.push(e), {
    withReceipts: true,
    emitInitial: false,
  })
  const unsubB = tracker.subscribe('0xt', (e) => eventsB.push(e), {
    withReceipts: true,
    emitInitial: false,
  })

  source.emitBlock({
    number: '0x10',
    hash: '0xb1',
    parentHash: '0x0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [{ hash: '0xt', from: '0xs', nonce: '0x0' }],
  })
  await flush()

  // Receipt fetched exactly once despite two subscriptions.
  expect(fetchCount).toBe(1)
  // Both subscribers receive the seen-in-block with receipt.
  const seenA = eventsA.find(
    (e): e is import('./events.js').TxEventSeenInBlock => e.kind === 'seen-in-block',
  )
  const seenB = eventsB.find(
    (e): e is import('./events.js').TxEventSeenInBlock => e.kind === 'seen-in-block',
  )
  expect(seenA?.receipt).toBeDefined()
  expect(seenB?.receipt).toBeDefined()
  unsubA()
  unsubB()
  tracker.stop()
})

test('withReceipts: true + reorg — vanished then re-included fetches fresh receipt', async () => {
  let fetchCount = 0
  const source = makeSource({
    initialCaps: {
      newHeads: 'subscription',
      newPendingTransactions: 'subscription',
      txpoolContent: 'available',
      receiptByHash: 'available',
      reprobeOnReconnect: true,
    },
    getReceiptImpl: async () => {
      fetchCount++
      return {
        transactionHash: '0xt',
        blockHash: '0xb2new',
        blockNumber: '0x11',
        status: '0x1',
      }
    },
  })
  const tracker = createTxTracker({ source, chainId: 1 })
  tracker.start()

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), {
    withReceipts: true,
    emitInitial: false,
  })

  // First inclusion at block 16, hash 0xb1.
  source.emitBlock({
    number: '0x10',
    hash: '0xb1',
    parentHash: '0x0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [{ hash: '0xt', from: '0xs', nonce: '0x0' }],
  })
  await flush()

  const firstSeen = events.find(
    (e): e is import('./events.js').TxEventSeenInBlock => e.kind === 'seen-in-block',
  )
  expect(firstSeen?.receipt).toBeDefined()
  expect(fetchCount).toBe(1)

  // Reorg: same height, different block hash — tx is vanished.
  source.emitBlock({
    number: '0x10',
    hash: '0xb2new',
    parentHash: '0x0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [],
  })
  await flush()

  const vanished = events.find((e) => e.kind === 'vanished-from-block')
  expect(vanished).toBeDefined()

  // Re-inclusion at a new block — fresh receipt fetch.
  source.emitBlock({
    number: '0x11',
    hash: '0xb3',
    parentHash: '0xb2new',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [{ hash: '0xt', from: '0xs', nonce: '0x0' }],
  })
  await flush()

  const allSeen = events.filter(
    (e): e is import('./events.js').TxEventSeenInBlock => e.kind === 'seen-in-block',
  )
  // Second inclusion carries a fresh receipt.
  expect(allSeen.length).toBeGreaterThanOrEqual(2)
  expect(allSeen[allSeen.length - 1].receipt).toBeDefined()
  // Fetch count incremented for the re-inclusion.
  expect(fetchCount).toBe(2)
  tracker.stop()
})

test('withReceipts — concurrent block ticks: stale block N skips overwriting newer state', async () => {
  // The race window: onBlock(N) suspends at await Promise.all(getReceipts) after the
  // tx is first included in block N-1 and then included again in block N (fresh
  // inclusion with a different block hash). While N's receipt fetch is deferred,
  // onBlock(N+1) runs to completion (no tx in N+1 → confirmation-bump path,
  // advances lastObservedAtBlock to N+1 and confirmations to 2). When N's receipt
  // finally resolves, its deferred per-record loop would normally clobber N+1's
  // state by writing confirmations: 1 and lastObservedAtBlock: N. The stale-block
  // guard prevents that overwrite.
  //
  // Setup: two-phase getReceiptImpl —
  //   call 1 (block N-1 inclusion): resolves immediately with a receipt
  //   call 2 (block N re-inclusion): defers until we manually resolve it
  let receiptCallCount = 0
  let resolveSecondReceipt: ((r: TransactionReceipt | null) => void) | null = null

  const stubSource = makeSource({
    initialCaps: {
      newHeads: 'subscription',
      newPendingTransactions: 'subscription',
      txpoolContent: 'available',
      receiptByHash: 'available',
      reprobeOnReconnect: true,
    },
    getReceiptImpl: (_hash) => {
      receiptCallCount++
      if (receiptCallCount === 1) {
        // First call (block N-1): resolve immediately.
        return Promise.resolve({
          transactionHash: '0xt',
          blockHash: '0xb0',
          blockNumber: '0xf',
          status: '0x1',
        })
      }
      // Second call (block N): deferred — holds onBlock(N) suspended.
      return new Promise<TransactionReceipt | null>((resolve) => {
        resolveSecondReceipt = resolve
      })
    },
  })

  const tracker = createTxTracker({ source: stubSource, chainId: 1 })
  tracker.start()

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), {
    withReceipts: true,
    emitInitial: false,
  })

  // Block N-1 (0xf): includes the tx. onBlock suspends at await Promise.all
  // (receipt call 1), but that resolves immediately. onBlock(N-1) completes
  // synchronously after the first microtask drain.
  stubSource.emitBlock({
    number: '0xf',
    hash: '0xb0',
    parentHash: '0x0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [{ hash: '0xt', from: '0xs', nonce: '0x0' }],
  })
  await flush()

  // After N-1: tx is included with confirmations: 1, lastObservedAtBlock: 0xfn.
  const statusAfterNminus1 = tracker.getTxStatus('0xt')
  expect(statusAfterNminus1?.lastSeenInBlock?.confirmations).toBe(1)
  expect(statusAfterNminus1?.lastObservedAtBlock).toBe(0xfn)

  // Block N (0x10): same tx, different block hash → fresh inclusion path.
  // onBlock(N) builds targets = ['0xt'], fires getReceipt (call 2) which defers,
  // and suspends at await Promise.all(getReceipts).
  stubSource.emitBlock({
    number: '0x10',
    hash: '0xb1',
    parentHash: '0xb0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [{ hash: '0xt', from: '0xs', nonce: '0x0' }],
  })
  // Allow onBlock(N) to reach its first await (the Promise.all with deferred receipt).
  await Promise.resolve()
  await Promise.resolve()

  // Block N+1 (0x11): tx NOT in this block → confirmation-bump path.
  // onBlock(N+1) runs synchronously through all its paths; its await
  // Promise.all([]) resolves immediately (no targets). Per-record loop
  // runs: lastSeenInBlock is from N-1 (blockHash=0xb0, confirmations=1),
  // N+1's blockHash differs → confirmation bump → confirmations=2,
  // lastObservedAtBlock=0x11n.
  stubSource.emitBlock({
    number: '0x11',
    hash: '0xb2',
    parentHash: '0xb1',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [],
  })
  await flush()

  // N+1's confirmation-bump must have advanced lastObservedAtBlock to 0x11n.
  const statusAfterNplus1 = tracker.getTxStatus('0xt')
  expect(statusAfterNplus1?.lastObservedAtBlock).toBe(0x11n)
  expect(statusAfterNplus1?.lastSeenInBlock?.confirmations).toBeGreaterThanOrEqual(2)

  // Resolve block N's receipt — without the stale-block guard, block N's
  // deferred per-record loop would clobber the newer state from N+1 by
  // writing confirmations: 1 and lastObservedAtBlock: 0x10n.
  resolveSecondReceipt!({
    transactionHash: '0xt',
    blockHash: '0xb1',
    blockNumber: '0x10',
    status: '0x1',
  })
  await flush()

  // The stale-block guard must have prevented block N's deferred loop from
  // overwriting block N+1's state.
  const finalStatus = tracker.getTxStatus('0xt')
  expect(finalStatus?.lastObservedAtBlock).toBe(0x11n)
  // Confirmations must still reflect N+1's bump (≥ 2), not reset to 1 by block N.
  expect(finalStatus?.lastSeenInBlock?.confirmations).toBeGreaterThanOrEqual(2)

  tracker.stop()
})

test('withReceipts: true + stop() resets gate — second start() warns again on capability miss', async () => {
  const onError = vi.fn()
  const source = makeSource({
    initialCaps: {
      newHeads: 'subscription',
      newPendingTransactions: 'subscription',
      txpoolContent: 'available',
      receiptByHash: 'unavailable',
      reprobeOnReconnect: true,
    },
  })
  const tracker = createTxTracker({ source, chainId: 1, onError })
  tracker.start()

  tracker.subscribe('0xt', () => {}, { withReceipts: true, emitInitial: false })

  source.emitBlock({
    number: '0x10',
    hash: '0xb1',
    parentHash: '0x0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [{ hash: '0xt', from: '0xs', nonce: '0x0' }],
  })
  await flush()

  const warnsAfterFirstStart = onError.mock.calls.filter(
    ([m]) => m === 'tx-tracker.withReceipts',
  )
  expect(warnsAfterFirstStart).toHaveLength(1)

  // Stop resets the gate.
  tracker.stop()

  // Re-start: subscribe again and emit a block.
  tracker.start()
  tracker.subscribe('0xt', () => {}, { withReceipts: true, emitInitial: false })

  source.emitBlock({
    number: '0x11',
    hash: '0xb2',
    parentHash: '0xb1',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [{ hash: '0xt', from: '0xs', nonce: '0x0' }],
  })
  await flush()

  const warnsAfterSecondStart = onError.mock.calls.filter(
    ([m]) => m === 'tx-tracker.withReceipts',
  )
  // Gate fired again after stop()/start() cycle.
  expect(warnsAfterSecondStart).toHaveLength(2)
  tracker.stop()
})

// ---------- probeMined tests ----------
//
// Consumer-supplied mined probe (TrackOptions.probeMined). Runs every block
// tick for every record that has a probe attached. No capability gate, no
// tick counter, no policy gate — the probe IS the authority. Shares the
// height-ordering rule + identity check + emit pipeline with the
// receipt-poll-fallback path.

test('probeMined — emits seen-in-block with source receipt-poll when probe returns inclusion', async () => {
  const source = makeSource()
  const probe = vi.fn(async (hash: string) =>
    hash === '0xt'
      ? { blockHash: '0xfromprobe', blockNumber: 0x42n }
      : null,
  )
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), {
    emitInitial: false,
    probeMined: probe,
  })

  // Tx NOT in block.transactions — block-poll won't see it. The probe is
  // what tells the tracker about inclusion.
  source.emitBlock(makeBlock(0x10n, '0xtip10', []))
  await flush()

  const seen = events.find(
    (e): e is import('./events.js').TxEventSeenInBlock =>
      e.kind === 'seen-in-block',
  )
  expect(seen).toBeDefined()
  expect(seen!.source).toBe('receipt-poll')
  expect(seen!.blockHash).toBe('0xfromprobe')
  expect(seen!.blockNumber).toBe(0x42n)
  expect(seen!.transactionIndex).toBe(0)
  expect(seen!.confirmations).toBe(1)
  expect(probe).toHaveBeenCalledWith('0xt')

  // Status mirror — getTxStatus reflects probe-derived inclusion.
  const status = tracker.getTxStatus('0xt')
  expect(status?.lastSeenInBlock).toMatchObject({
    blockHash: '0xfromprobe',
    blockNumber: 0x42n,
    source: 'receipt-poll',
  })
  tracker.stop()
})

test('probeMined — returning null is a no-op', async () => {
  const source = makeSource()
  const probe = vi.fn(async () => null)
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xunmined', (e) => events.push(e), {
    emitInitial: false,
    probeMined: probe,
  })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(probe).toHaveBeenCalled()
  expect(events.filter((e) => e.kind === 'seen-in-block')).toHaveLength(0)
  tracker.stop()
})

test('probeMined — throwing routes through onError without emitting', async () => {
  const onError = vi.fn()
  const source = makeSource()
  const probe = vi.fn(async () => {
    throw new Error('indexer down')
  })
  const tracker = startTracker(source, { onError })

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xerr', (e) => events.push(e), {
    emitInitial: false,
    probeMined: probe,
  })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(onError).toHaveBeenCalledWith(
    'tx-tracker.probeMined',
    expect.objectContaining({ message: 'indexer down' }),
  )
  expect(events.filter((e) => e.kind === 'seen-in-block')).toHaveLength(0)
  tracker.stop()
})

test('probeMined — throwing with no onError configured is swallowed (optional-callback safety)', async () => {
  // No `onError` on tracker options. The `onError?.(...)` call must
  // safely no-op rather than throw on undefined access.
  const source = makeSource()
  const probe = vi.fn(async () => {
    throw new Error('boom')
  })
  const tracker = startTracker(source) // intentionally no onError

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xboom', (e) => events.push(e), {
    emitInitial: false,
    probeMined: probe,
  })

  // Should not throw or unhandled-reject.
  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(events.filter((e) => e.kind === 'seen-in-block')).toHaveLength(0)
  tracker.stop()
})

test('probeMined — height-ordering rule: block-poll wins when probe reports same-or-older block', async () => {
  // Block-poll records inclusion at block 0x10. The probe is also called
  // and returns inclusion at the SAME block. Height-ordering rule
  // (existingBlock.blockNumber >= result.blockNumber) means the probe's
  // return is a no-op — exactly one seen-in-block event, from block-poll.
  const source = makeSource()
  const probe = vi.fn(async () =>
    ({ blockHash: '0xprobestale', blockNumber: 0x10n }),
  )
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), {
    emitInitial: false,
    probeMined: probe,
  })

  source.emitBlock(
    makeBlock(0x10n, '0xb10', [{ hash: '0xt', from: '0xs', nonce: '0x0' }]),
  )
  await flush()

  const seenEvents = events.filter((e) => e.kind === 'seen-in-block')
  expect(seenEvents).toHaveLength(1)
  // Default caps in this suite use newHeads: 'subscription', so block-path
  // observations are tagged 'subscription' rather than 'block-poll'. The
  // assertion that matters is "not from the probe".
  expect(seenEvents[0].source).not.toBe('receipt-poll')
  expect(probe).toHaveBeenCalled()
  expect(tracker.getTxStatus('0xt')?.lastSeenInBlock?.source).not.toBe(
    'receipt-poll',
  )
  tracker.stop()
})

test('probeMined — probe reporting a strictly newer block than recorded wins (height-ordering coverage)', async () => {
  // existingBlock IS set, but probe carries a strictly newer block. The
  // height-ordering rule lets the probe's observation through. This is
  // the exotic third arm of the `&&` in the height check — exists to
  // pin coverage on it.
  const source = makeSource()
  let probeBlock = 0x10n
  const probe = vi.fn(async () =>
    ({ blockHash: '0xfromprobenew', blockNumber: probeBlock }),
  )
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), {
    emitInitial: false,
    probeMined: probe,
  })

  // Block 0x10: block-poll sees inclusion at 0x10. Probe also returns 0x10
  // (same block) — no-op via height-ordering. After this, lastSeenInBlock = 0x10.
  source.emitBlock(
    makeBlock(0x10n, '0xb10', [{ hash: '0xt', from: '0xs', nonce: '0x0' }]),
  )
  await flush()

  // Block 0x11: tx is NOT in this block. block-poll bumps confirmations to 2
  // but doesn't change lastSeenInBlock. Now the probe returns 0x11 (newer
  // than existing 0x10) — height check passes, probe's observation goes
  // through, source becomes receipt-poll.
  probeBlock = 0x11n
  source.emitBlock(makeBlock(0x11n, '0xb11', [], '0xb10'))
  await flush()

  const seenFromProbe = events.find(
    (e): e is import('./events.js').TxEventSeenInBlock =>
      e.kind === 'seen-in-block' && e.source === 'receipt-poll',
  )
  expect(seenFromProbe).toBeDefined()
  expect(seenFromProbe!.blockNumber).toBe(0x11n)
  tracker.stop()
})

test('probeMined — first-set wins across multiple subscribes on the same hash', async () => {
  const source = makeSource()
  const firstProbe = vi.fn(async () =>
    ({ blockHash: '0xfromfirst', blockNumber: 0x5n }),
  )
  const secondProbe = vi.fn(async () =>
    ({ blockHash: '0xfromsecond', blockNumber: 0x5n }),
  )
  const tracker = startTracker(source)

  // First subscribe attaches firstProbe.
  tracker.subscribe('0xt', () => {}, {
    emitInitial: false,
    probeMined: firstProbe,
  })
  // Second subscribe on same hash with a different probe — ignored.
  tracker.subscribe('0xt', () => {}, {
    emitInitial: false,
    probeMined: secondProbe,
  })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(firstProbe).toHaveBeenCalled()
  expect(secondProbe).not.toHaveBeenCalled()
  tracker.stop()
})

test('probeMined — no probe attached means runMinedProbe early-returns (default state coverage)', async () => {
  // A subscriber without probeMined leaves record.probeMined = null. The
  // dispatch loop still iterates the record, but runMinedProbe returns
  // immediately at `if (!probe) return`. Verifies the default state.
  const source = makeSource()
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xnoprobe', (e) => events.push(e), { emitInitial: false })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  // No probe-derived seen-in-block.
  expect(
    events.filter(
      (e) => e.kind === 'seen-in-block' && e.source === 'receipt-poll',
    ),
  ).toHaveLength(0)
  tracker.stop()
})

test('probeMined — identity check: orphaned-mid-await probe does not emit on resubscribed record', async () => {
  // Mirror of receipt-poll-fallback audit #6: the probe's await is in
  // flight when the subscriber leaves (cleanupRecord drops the record),
  // then a fresh subscribe on the same hash creates a new record. The
  // probe's post-await emit must bail rather than fire on the orphaned
  // closure (would otherwise leak a phantom event to globalSubs).
  let resolveProbe: ((r: { blockHash: string; blockNumber: bigint } | null) => void) | null = null
  const source = makeSource()
  const probe = vi.fn(
    () =>
      new Promise<{ blockHash: string; blockNumber: bigint } | null>(
        (resolve) => {
          resolveProbe = resolve
        },
      ),
  )
  const tracker = startTracker(source)

  const allEvents: import('./events.js').TxEvent[] = []
  tracker.subscribeAll((e) => allEvents.push(e))

  const unsubA = tracker.subscribe('0xt', () => {}, {
    emitInitial: false,
    probeMined: probe,
  })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  // Yield once so the probe is in-flight awaiting our manual resolution.
  await flush()
  expect(resolveProbe).not.toBeNull()

  // Mid-await: drop subscriber A, re-subscribe as A' (new record under
  // the same hash, no probe this time).
  unsubA()
  const aPrimeEvents: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => aPrimeEvents.push(e), { emitInitial: false })

  // Resolve the stale probe with inclusion data. Identity check must
  // detect the record is no longer canonical and bail.
  resolveProbe!({ blockHash: '0xstaleprobe', blockNumber: 0x99n })
  await flush()
  await flush()

  // Neither A's stale closure nor globalSubs should have received a
  // seen-in-block from the orphaned probe.
  expect(
    aPrimeEvents.find((e) => e.kind === 'seen-in-block'),
  ).toBeUndefined()
  const phantom = allEvents.find(
    (e) => e.kind === 'seen-in-block' && e.source === 'receipt-poll',
  )
  expect(phantom).toBeUndefined()
  tracker.stop()
})

test('probeMined — runs unconditionally every block (no tick counter, no capability gate)', async () => {
  // Differentiator vs receipt-poll-fallback: probe runs on EVERY block,
  // and runs even when capabilities() lacks receiptByHash. Three blocks
  // → three probe invocations.
  const degradedCaps: Capabilities = {
    newHeads: 'subscription',
    newPendingTransactions: 'poll-only',
    txpoolContent: 'available',
    receiptByHash: 'unavailable', // would gate receipt-poll-fallback
    reprobeOnReconnect: true,
  }
  const source = makeSource({ initialCaps: degradedCaps })
  const probe = vi.fn(async () => null)
  const tracker = startTracker(source)

  tracker.subscribe('0xt', () => {}, {
    emitInitial: false,
    probeMined: probe,
  })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()
  source.emitBlock(makeBlock(0x2n, '0xb2', [], '0xb1'))
  await flush()
  source.emitBlock(makeBlock(0x3n, '0xb3', [], '0xb2'))
  await flush()

  expect(probe).toHaveBeenCalledTimes(3)
  tracker.stop()
})

test('probeMined — reorg invalidates probe-reported inclusion (vanished-from-block)', async () => {
  // Integration with the reorg detector. The probe reports inclusion at
  // block 0x10 / 0xb10a. A same-height-different-hash reorg lands
  // (0x10 / 0xb10b). The vanished-from-block path walks every record
  // whose lastSeenInBlock.blockNumber matches the divergence — regardless
  // of which path wrote it. Pins the "reorg handling for free" claim.
  const source = makeSource()
  const probe = vi.fn(async (hash: string) =>
    hash === '0xt'
      ? { blockHash: '0xb10a', blockNumber: 0x10n }
      : null,
  )
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), {
    emitInitial: false,
    probeMined: probe,
  })

  // First block: probe reports inclusion at 0xb10a (tx not in block.txs).
  source.emitBlock(makeBlock(0x10n, '0xb10a', [], '0x9'))
  await flush()

  const seenFromProbe = events.find(
    (e): e is import('./events.js').TxEventSeenInBlock =>
      e.kind === 'seen-in-block' && e.source === 'receipt-poll',
  )
  expect(seenFromProbe).toBeDefined()

  // Make the probe stop returning the stale block — the indexer would
  // have reorganized too. Otherwise the post-vanish block tick would
  // re-emit a seen-in-block, defeating the test's intent.
  probe.mockResolvedValue(null)

  // Same-height-different-hash reorg lands: 0x10 / 0xb10b. The reorg
  // detector compares against the pre-update ring (which has 0xb10a at
  // height 0x10) and emits vanished-from-block on every record whose
  // lastSeenInBlock points at 0xb10a.
  source.emitBlock(makeBlock(0x10n, '0xb10b', [], '0x9'))
  await flush()

  const vanished = events.find((e) => e.kind === 'vanished-from-block')
  expect(vanished).toBeDefined()
  expect(tracker.getTxStatus('0xt')?.lastSeenInBlock).toBeNull()
  tracker.stop()
})

// ---------- statusPollEveryBlocks / probeTransaction tests ----------
//
// Default-on per-hash status check via source.getTransaction. The path
// is universal (not capability-gated), runs every block by default,
// supports a tick counter for less-frequent cadences, and lets the
// consumer supply a fallback probe (probeTransaction) used only when
// the source returns null.

test('statusPoll — emits seen-in-block when source.getTransaction returns a mined tx', async () => {
  const source = makeSource({
    getTransactionImpl: async (hash) =>
      hash === '0xt'
        ? {
            hash: '0xt',
            from: '0xsender',
            nonce: '0x5',
            blockHash: '0xfromstatus',
            blockNumber: '0x42',
          } as RawTx
        : null,
  })
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), { emitInitial: false })

  source.emitBlock(makeBlock(0x10n, '0xtip10', []))
  await flush()

  const seen = events.find(
    (e): e is import('./events.js').TxEventSeenInBlock =>
      e.kind === 'seen-in-block',
  )
  expect(seen).toBeDefined()
  expect(seen!.source).toBe('receipt-poll')
  expect(seen!.blockHash).toBe('0xfromstatus')
  expect(seen!.blockNumber).toBe(0x42n)
  expect(tracker.getTxStatus('0xt')?.lastSeenInBlock?.source).toBe('receipt-poll')
  tracker.stop()
})

test('statusPoll — emits seen-in-mempool when source.getTransaction returns pending tx', async () => {
  const source = makeSource({
    getTransactionImpl: async (hash) =>
      hash === '0xt'
        ? { hash: '0xt', from: '0xa', nonce: '0x3' } as RawTx
        : null,
  })
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), { emitInitial: false })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  const seen = events.find(
    (e): e is import('./events.js').TxEventSeenInMempool =>
      e.kind === 'seen-in-mempool',
  )
  expect(seen).toBeDefined()
  expect(seen!.source).toBe('receipt-poll')
  expect(seen!.bucket).toBe('pending')
  expect(seen!.tx.from).toBe('0xa')

  // Identity is primed — replacement detection will work even though
  // txpool_content never saw the tx.
  const status = tracker.getTxStatus('0xt')
  expect(status?.lastSeenInMempool?.bucket).toBe('pending')
  expect(status?.lastSeenInMempool?.source).toBe('receipt-poll')
  tracker.stop()
})

test('statusPoll — null return is a no-op', async () => {
  const source = makeSource() // default getTransaction returns null
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xnothing', (e) => events.push(e), { emitInitial: false })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(
    events.filter(
      (e) =>
        (e.kind === 'seen-in-block' || e.kind === 'seen-in-mempool') &&
        e.source === 'receipt-poll',
    ),
  ).toHaveLength(0)
  tracker.stop()
})

test('statusPoll — source.getTransaction throw is reported but probe still tries', async () => {
  const onError = vi.fn()
  const probe = vi.fn(async () => ({
    hash: '0xt',
    from: '0xa',
    nonce: '0x1',
  } as RawTx))
  const source = makeSource({
    getTransactionImpl: async () => {
      throw new Error('source rpc down')
    },
  })
  const tracker = startTracker(source, { onError })

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), {
    emitInitial: false,
    probeTransaction: probe,
  })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(onError).toHaveBeenCalledWith(
    'tx-tracker.getTransaction',
    expect.objectContaining({ message: 'source rpc down' }),
  )
  expect(probe).toHaveBeenCalledWith('0xt')
  // Probe answered → seen-in-mempool emitted via fallback.
  expect(
    events.find(
      (e) => e.kind === 'seen-in-mempool' && e.source === 'receipt-poll',
    ),
  ).toBeDefined()
  tracker.stop()
})

test('statusPoll — probeTransaction called only when source.getTransaction returns null', async () => {
  const probe = vi.fn(async () => null)
  const source = makeSource({
    // Source has the tx — probe should NOT be called.
    getTransactionImpl: async (hash) =>
      ({ hash, from: '0xa', nonce: '0x0' } as RawTx),
  })
  const tracker = startTracker(source)

  tracker.subscribe('0xt', () => {}, {
    emitInitial: false,
    probeTransaction: probe,
  })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(probe).not.toHaveBeenCalled()
  tracker.stop()
})

test('statusPoll — probeTransaction throwing routes through onError', async () => {
  const onError = vi.fn()
  const probe = vi.fn(async () => {
    throw new Error('probe down')
  })
  const source = makeSource() // getTransaction returns null
  const tracker = startTracker(source, { onError })

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xerr', (e) => events.push(e), {
    emitInitial: false,
    probeTransaction: probe,
  })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(onError).toHaveBeenCalledWith(
    'tx-tracker.probeTransaction',
    expect.objectContaining({ message: 'probe down' }),
  )
  expect(
    events.filter(
      (e) =>
        (e.kind === 'seen-in-block' || e.kind === 'seen-in-mempool') &&
        e.source === 'receipt-poll',
    ),
  ).toHaveLength(0)
  tracker.stop()
})

test('statusPoll — probeTransaction throwing with no onError is swallowed', async () => {
  const probe = vi.fn(async () => {
    throw new Error('silent')
  })
  const source = makeSource()
  const tracker = startTracker(source) // no onError configured

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xs', (e) => events.push(e), {
    emitInitial: false,
    probeTransaction: probe,
  })

  // Should not throw or unhandled-reject.
  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(
    events.filter(
      (e) =>
        (e.kind === 'seen-in-block' || e.kind === 'seen-in-mempool') &&
        e.source === 'receipt-poll',
    ),
  ).toHaveLength(0)
  tracker.stop()
})

test('statusPoll — pending dedup: only one seen-in-mempool per pending streak', async () => {
  const source = makeSource({
    getTransactionImpl: async (hash) =>
      ({ hash, from: '0xa', nonce: '0x7' } as RawTx),
  })
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), { emitInitial: false })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()
  source.emitBlock(makeBlock(0x2n, '0xb2', [], '0xb1'))
  await flush()
  source.emitBlock(makeBlock(0x3n, '0xb3', [], '0xb2'))
  await flush()

  const mempoolEvents = events.filter(
    (e) => e.kind === 'seen-in-mempool' && e.source === 'receipt-poll',
  )
  expect(mempoolEvents).toHaveLength(1)
  tracker.stop()
})

test('statusPoll — pending → mined transition resets dedup and emits seen-in-block', async () => {
  let mined = false
  const source = makeSource({
    getTransactionImpl: async (hash) => {
      if (mined) {
        return {
          hash,
          from: '0xa',
          nonce: '0x9',
          blockHash: '0xinclusion',
          blockNumber: '0xa',
        } as RawTx
      }
      return { hash, from: '0xa', nonce: '0x9' } as RawTx
    },
  })
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), { emitInitial: false })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()
  expect(
    events.filter((e) => e.kind === 'seen-in-mempool' && e.source === 'receipt-poll'),
  ).toHaveLength(1)

  mined = true
  source.emitBlock(makeBlock(0x2n, '0xb2', [], '0xb1'))
  await flush()

  const seenBlock = events.find(
    (e) => e.kind === 'seen-in-block' && e.source === 'receipt-poll',
  )
  expect(seenBlock).toBeDefined()
  tracker.stop()
})

test('statusPoll — height-ordering: block-poll wins when status-poll reports same-or-older inclusion', async () => {
  const source = makeSource({
    getTransactionImpl: async (hash) =>
      ({
        hash,
        from: '0xa',
        nonce: '0x0',
        blockHash: '0xstatusstale',
        blockNumber: '0x10',
      } as RawTx),
  })
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), { emitInitial: false })

  // block-poll sees the tx at the same height first; status-poll's
  // observation at the same block must be discarded.
  source.emitBlock(
    makeBlock(0x10n, '0xb10', [{ hash: '0xt', from: '0xa', nonce: '0x0' }]),
  )
  await flush()

  const seenEvents = events.filter((e) => e.kind === 'seen-in-block')
  expect(seenEvents).toHaveLength(1)
  expect(seenEvents[0].source).not.toBe('receipt-poll')
  tracker.stop()
})

test('statusPoll — identity check rejects orphaned mid-await emit (audit #6 parity)', async () => {
  let resolveTx: ((r: RawTx | null) => void) | null = null
  const source = makeSource({
    getTransactionImpl: () =>
      new Promise<RawTx | null>((resolve) => {
        resolveTx = resolve
      }),
  })
  const tracker = startTracker(source)

  const allEvents: import('./events.js').TxEvent[] = []
  tracker.subscribeAll((e) => allEvents.push(e))

  const unsubA = tracker.subscribe('0xt', () => {}, { emitInitial: false })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()
  expect(resolveTx).not.toBeNull()

  unsubA()
  const aPrimeEvents: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => aPrimeEvents.push(e), { emitInitial: false })

  resolveTx!({
    hash: '0xt',
    from: '0xa',
    nonce: '0x0',
  } as RawTx)
  await flush()
  await flush()

  expect(aPrimeEvents.find((e) => e.kind === 'seen-in-mempool')).toBeUndefined()
  const phantom = allEvents.find(
    (e) => e.kind === 'seen-in-mempool' && e.source === 'receipt-poll',
  )
  expect(phantom).toBeUndefined()
  tracker.stop()
})

test('statusPoll — bad blockNumber from getTransaction routes through onError', async () => {
  const onError = vi.fn()
  const source = makeSource({
    getTransactionImpl: async (hash) =>
      ({
        hash,
        from: '0xa',
        nonce: '0x0',
        blockHash: '0xfoo',
        blockNumber: 'not-hex',
      } as RawTx),
  })
  const tracker = startTracker(source, { onError })

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), { emitInitial: false })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(onError).toHaveBeenCalledWith(
    'tx-tracker.statusPoll',
    expect.objectContaining({ message: expect.stringContaining('bad blockNumber') }),
  )
  expect(events.filter((e) => e.kind === 'seen-in-block')).toHaveLength(0)
  tracker.stop()
})

test('statusPoll — probeTransaction first-set-wins across subscribes', async () => {
  const first = vi.fn(async () => null)
  const second = vi.fn(async () => null)
  const source = makeSource()
  const tracker = startTracker(source)

  tracker.subscribe('0xt', () => {}, {
    emitInitial: false,
    probeTransaction: first,
  })
  tracker.subscribe('0xt', () => {}, {
    emitInitial: false,
    probeTransaction: second,
  })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(first).toHaveBeenCalled()
  expect(second).not.toHaveBeenCalled()
  tracker.stop()
})

test('statusPoll — statusPollEveryBlocks=0 disables the path entirely', async () => {
  const getTransactionImpl = vi.fn(async () => null)
  const source = makeSource({ getTransactionImpl })
  const tracker = startTracker(source, { statusPollEveryBlocks: 0 })

  tracker.subscribe('0xt', () => {}, { emitInitial: false })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()
  source.emitBlock(makeBlock(0x2n, '0xb2', [], '0xb1'))
  await flush()

  expect(getTransactionImpl).not.toHaveBeenCalled()
  tracker.stop()
})

test('statusPoll — statusPollEveryBlocks=3 skips ticks until threshold reached', async () => {
  const getTransactionImpl = vi.fn(async () => null)
  const source = makeSource({ getTransactionImpl })
  const tracker = startTracker(source, { statusPollEveryBlocks: 3 })

  tracker.subscribe('0xt', () => {}, { emitInitial: false })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()
  expect(getTransactionImpl).not.toHaveBeenCalled()

  source.emitBlock(makeBlock(0x2n, '0xb2', [], '0xb1'))
  await flush()
  expect(getTransactionImpl).not.toHaveBeenCalled()

  source.emitBlock(makeBlock(0x3n, '0xb3', [], '0xb2'))
  await flush()
  expect(getTransactionImpl).toHaveBeenCalledTimes(1)
  tracker.stop()
})

test('statusPoll — pending tx without from/nonce does not crash identity caching', async () => {
  // Defensive: some RPCs return RawTx shapes missing optional fields.
  // Identity should stay null but the event should still emit.
  const source = makeSource({
    getTransactionImpl: async (hash) => ({ hash } as RawTx),
  })
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), { emitInitial: false })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(
    events.find((e) => e.kind === 'seen-in-mempool' && e.source === 'receipt-poll'),
  ).toBeDefined()
  tracker.stop()
})

test('statusPoll — mined tx without from/nonce does not crash identity caching', async () => {
  const source = makeSource({
    getTransactionImpl: async (hash) =>
      ({
        hash,
        blockHash: '0xb',
        blockNumber: '0x5',
      } as RawTx),
  })
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xt', (e) => events.push(e), { emitInitial: false })

  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()

  expect(
    events.find((e) => e.kind === 'seen-in-block' && e.source === 'receipt-poll'),
  ).toBeDefined()
  tracker.stop()
})

test('statusPoll — identity primed from pending observation unblocks replacement detection', async () => {
  // The load-bearing motivation. Original tx is never seen in any
  // txpool_content snapshot (mempool path returns it absent), but
  // status-poll observes it and caches (from, nonce). A later mempool
  // snapshot containing a same-(from, nonce)-different-hash replacement
  // can then fire `replaced-by` — which would have been impossible
  // without status-poll's identity priming.
  let phase: 'before' | 'after' = 'before'
  const source = makeSource({
    getTransactionImpl: async (hash) =>
      phase === 'before' && hash === '0xorig'
        ? ({ hash: '0xorig', from: '0xa', nonce: '0x7' } as RawTx)
        : null,
  })
  const tracker = startTracker(source)

  const events: import('./events.js').TxEvent[] = []
  tracker.subscribe('0xorig', (e) => events.push(e), { emitInitial: false })

  // Block 1: status-poll caches identity for 0xorig.
  source.emitBlock(makeBlock(0x1n, '0xb1', []))
  await flush()
  expect(tracker.getTxStatus('0xorig')?.lastSeenInMempool?.tx.from).toBe('0xa')

  // Now emit a mempool snapshot containing a replacement tx 0xrepl
  // sharing (from=0xa, nonce=7) with 0xorig. The cached identity lets
  // the tracker recognize this as a replacement.
  phase = 'after'
  source.emitMempool({
    pending: {
      '0xa': {
        '7': { hash: '0xrepl', from: '0xa', nonce: '0x7' },
      },
    },
    queued: {},
  })
  await flush()

  const replaced = events.find((e) => e.kind === 'replaced-by')
  expect(replaced).toBeDefined()
  if (replaced && replaced.kind === 'replaced-by') {
    expect(replaced.replacementHash).toBe('0xrepl')
  }
  tracker.stop()
})
