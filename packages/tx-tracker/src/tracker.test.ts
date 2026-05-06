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
