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
import { test, expect } from 'vitest'

import type {
  BlockResult,
  Capabilities,
  ChainSource,
  NormalizedMempool,
  RawTx,
  TransactionReceipt,
  FeeHistoryResult,
} from '@valve-tech/chain-source'

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

const makeSource = (initialCaps?: Capabilities): StubSource => {
  const blockSubs = new Set<(b: BlockResult) => void>()
  const mempoolSubs = new Set<(s: NormalizedMempool) => void>()
  let caps: Capabilities = initialCaps ?? DEFAULT_CAPS
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
    getReceipt: async (): Promise<TransactionReceipt | null> => null,
    getTransaction: async (): Promise<RawTx | null> => null,
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
