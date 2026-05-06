/**
 * Capability-matrix matrix tests — pin the "no silent downgrade"
 * invariant from spec §2.2 + §17.3.
 *
 * The tracker must produce the **same observed-state** for the same
 * ground-truth chain history, regardless of which upstream capabilities
 * are available. Different capabilities legitimately change the
 * `source` field on each event (`'subscription'` vs `'block-poll'`,
 * etc.) but never the **set / order / payload** of events emitted.
 *
 * **Why this matters now, even though v0.6.x doesn't wire eth_subscribe yet:**
 * the value of capability disclosure is the contract it locks down for
 * future changes. When WS push paths land in a follow-up release, this
 * suite is the regression guard preventing a "subscription path silently
 * skips left-mempool" bug, or a "block-poll path emits an extra
 * confirmation count" mismatch. Without these tests, capability-driven
 * code paths would only be smoke-tested in production.
 *
 * Method: drive an identical fixture sequence (mempool snapshots +
 * blocks) through four source stubs, each with a different fixed
 * capability profile. Assert that the resulting event streams match
 * on every field except `source` (the legitimate variation), and that
 * `source` itself takes the value the capability allows.
 */
import { test, expect } from 'vitest'

import type {
  BlockResult,
  Capabilities,
  ChainSource,
  EventSource,
  FeeHistoryResult,
  NormalizedMempool,
  RawTx,
  TransactionReceipt,
} from '@valve-tech/chain-source'

import type { TxEvent } from './events.js'
import { createTxTracker } from './tracker.js'

// -------------- capability profiles --------------

/**
 * Profile A — every capability available at its highest authority.
 * Push subscriptions for blocks + mempool, txpool_content + receipts
 * both reachable. Maps to a Geth/Reth full node with WS exposed.
 */
const PROFILE_ALL: Capabilities = {
  newHeads: 'subscription',
  newPendingTransactions: 'subscription',
  txpoolContent: 'available',
  receiptByHash: 'available',
  reprobeOnReconnect: true,
}

/**
 * Profile B — WS push for both block and mempool channels, but
 * txpool_content + receipts gated. A typical Infura-style provider
 * with eth_subscribe enabled but admin methods locked down.
 */
const PROFILE_WS_ONLY: Capabilities = {
  newHeads: 'subscription',
  newPendingTransactions: 'subscription',
  txpoolContent: 'gated',
  receiptByHash: 'unavailable',
  reprobeOnReconnect: true,
}

/**
 * Profile C — HTTP poll for everything, but txpool_content + receipts
 * reachable. A self-hosted full node behind an HTTP-only proxy.
 */
const PROFILE_HTTP_ONLY: Capabilities = {
  newHeads: 'poll-only',
  newPendingTransactions: 'poll-only',
  txpoolContent: 'available',
  receiptByHash: 'available',
  reprobeOnReconnect: false,
}

/**
 * Profile D — most degraded reachable corner: receipt-poll is the
 * ONLY authoritative inclusion-check path. No WS, no mempool.
 * Common against archival-only HTTP endpoints.
 */
const PROFILE_RECEIPT_POLL_ONLY: Capabilities = {
  newHeads: 'poll-only',
  newPendingTransactions: 'unavailable',
  txpoolContent: 'gated',
  receiptByHash: 'available',
  reprobeOnReconnect: false,
}

const PROFILES = [
  ['all', PROFILE_ALL] as const,
  ['ws-only', PROFILE_WS_ONLY] as const,
  ['http-only', PROFILE_HTTP_ONLY] as const,
  ['receipt-poll-only', PROFILE_RECEIPT_POLL_ONLY] as const,
]

// -------------- stub source --------------

interface StubSource extends ChainSource {
  emitBlock: (block: BlockResult) => void
  emitMempool: (snapshot: NormalizedMempool) => void
}

const makeSource = (caps: Capabilities): StubSource => {
  const blockSubs = new Set<(b: BlockResult) => void>()
  const mempoolSubs = new Set<(s: NormalizedMempool) => void>()
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
  }
}

// -------------- fixture sequence --------------

/**
 * The deterministic chain history every profile sees. One tracked
 * hash. Sequence:
 *
 *   tick 0: mempool snapshot containing tracked tx (pending bucket)
 *   tick 1: block 100 includes the tx at index 0
 *   tick 2: empty mempool snapshot — drives left-mempool emit
 *   tick 3: block 101 (no inclusion — bumps confirmations)
 *   tick 4: block 102 (no inclusion — bumps confirmations)
 *
 * Picks a sequence that exercises seen-in-mempool, left-mempool,
 * seen-in-block, and two confirmation bumps. The empty-mempool
 * tick is intentional: spec §6.1 doesn't make left-mempool follow
 * automatically from a block consuming the hash — the tracker only
 * knows mempool absence via a fresh mempool snapshot. Driving it
 * explicitly here makes the matrix exercise that path.
 *
 * Avoids signal-degraded/recovered (capabilities are static within
 * each run) and reorg events (clean chain extension).
 */
const TRACKED_HASH = '0xabc'
const SENDER = '0xsender'
const NONCE = '0x5'
const TRACKED_TX: RawTx = { hash: TRACKED_HASH, from: SENDER, nonce: NONCE }

interface FixtureTick {
  kind: 'mempool' | 'block'
  payload: NormalizedMempool | BlockResult
}

const makeBlock = (
  number: bigint,
  hash: string,
  txs: RawTx[],
  parentHash: string,
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

const FIXTURE: FixtureTick[] = [
  {
    kind: 'mempool',
    payload: {
      pending: { [SENDER]: { [parseInt(NONCE, 16).toString()]: TRACKED_TX } },
      queued: {},
    },
  },
  {
    kind: 'block',
    payload: makeBlock(100n, '0xb1', [TRACKED_TX], '0xparent'),
  },
  {
    kind: 'mempool',
    payload: { pending: {}, queued: {} },
  },
  {
    kind: 'block',
    payload: makeBlock(101n, '0xb2', [], '0xb1'),
  },
  {
    kind: 'block',
    payload: makeBlock(102n, '0xb3', [], '0xb2'),
  },
]

/**
 * Run the fixture against one capability profile and collect the
 * resulting event stream for the tracked hash.
 */
const runFixture = (caps: Capabilities): TxEvent[] => {
  const source = makeSource(caps)
  const tracker = createTxTracker({ source, chainId: 1 })
  tracker.start()
  const events: TxEvent[] = []
  const unsub = tracker.subscribe(
    TRACKED_HASH,
    (event) => events.push(event),
    { emitInitial: false },
  )
  for (const tick of FIXTURE) {
    if (tick.kind === 'mempool') {
      source.emitMempool(tick.payload as NormalizedMempool)
    } else {
      source.emitBlock(tick.payload as BlockResult)
    }
  }
  unsub()
  tracker.stop()
  // Drop the synthetic stopped event from the unsub — the matrix
  // assertion is about the substantive event sequence, not subscription
  // teardown bookkeeping.
  return events.filter((e) => e.kind !== 'stopped')
}

/**
 * Strip `source` from an event for cross-profile comparison. The
 * `source` field is the one legitimate per-profile variation; every
 * other field must be identical.
 */
const stripSource = (event: TxEvent): Omit<TxEvent, 'source'> => {
  const { source: _source, ...rest } = event
  return rest
}

// -------------- matrix tests --------------

test('every profile produces the same kind sequence for the same fixture', () => {
  const streams = PROFILES.map(([name, caps]) => ({
    name,
    events: runFixture(caps),
  }))
  const baseline = streams[0]
  for (const stream of streams.slice(1)) {
    expect(
      stream.events.map((e) => e.kind),
      `profile=${stream.name} kinds differ from profile=${baseline.name}`,
    ).toEqual(baseline.events.map((e) => e.kind))
  }
})

test('every profile produces the same payloads modulo source field', () => {
  const streams = PROFILES.map(([name, caps]) => ({
    name,
    events: runFixture(caps),
  }))
  const baseline = streams[0]
  const baselineStripped = baseline.events.map(stripSource)
  for (const stream of streams.slice(1)) {
    expect(
      stream.events.map(stripSource),
      `profile=${stream.name} payloads differ from profile=${baseline.name} (modulo source)`,
    ).toEqual(baselineStripped)
  }
})

test('source field varies according to capability profile', () => {
  // For each profile, the block-side events should carry 'subscription'
  // when newHeads is push-capable, otherwise 'block-poll'. The
  // mempool-side events should carry 'subscription' when
  // newPendingTransactions is push-capable, otherwise 'mempool-snapshot'.
  for (const [name, caps] of PROFILES) {
    const events = runFixture(caps)
    const expectedBlockSource: EventSource =
      caps.newHeads === 'subscription' ? 'subscription' : 'block-poll'
    const expectedMempoolSource: EventSource =
      caps.newPendingTransactions === 'subscription'
        ? 'subscription'
        : 'mempool-snapshot'
    for (const event of events) {
      const expected =
        event.kind === 'seen-in-mempool' || event.kind === 'left-mempool'
          ? expectedMempoolSource
          : expectedBlockSource
      expect(
        event.source,
        `profile=${name} kind=${event.kind} expected source=${expected}, got ${event.source}`,
      ).toBe(expected)
    }
  }
})

test('every profile emits at least the load-bearing variants for the fixture', () => {
  // Sanity check on the fixture itself: regardless of profile, the
  // sequence we drive should produce seen-in-mempool, left-mempool
  // (implicit when block consumes the hash from mempool view),
  // seen-in-block, and confirmation bumps. If a future change to
  // the fixture quietly drops one of these, the matrix tests above
  // would still pass (all profiles equally drop it) — this guard
  // prevents that silent regression.
  for (const [name, caps] of PROFILES) {
    const events = runFixture(caps)
    const kinds = new Set(events.map((e) => e.kind))
    expect(
      kinds.has('seen-in-mempool'),
      `profile=${name} missing seen-in-mempool`,
    ).toBe(true)
    expect(
      kinds.has('left-mempool'),
      `profile=${name} missing left-mempool (block should consume mempool entry)`,
    ).toBe(true)
    expect(
      kinds.has('seen-in-block'),
      `profile=${name} missing seen-in-block`,
    ).toBe(true)
  }
})

test('confirmations advance identically across profiles', () => {
  // The numeric confirmation count is the consumer-visible "how
  // settled is this" signal — divergence here would silently shift
  // when consumers see "Confirmed" in their UX. Pin separately from
  // the kind/payload sweep so a regression here surfaces as its own
  // assertion failure with a helpful diff.
  const expectedSequence = [1, 2, 3]
  for (const [name, caps] of PROFILES) {
    const events = runFixture(caps)
    const confirmations = events
      .filter(
        (e): e is import('./events.js').TxEventSeenInBlock =>
          e.kind === 'seen-in-block',
      )
      .map((e) => e.confirmations)
    expect(
      confirmations,
      `profile=${name} confirmations=${confirmations.join(',')} expected ${expectedSequence.join(',')}`,
    ).toEqual(expectedSequence)
  }
})

test('no profile silently emits a signal-degraded event on a static-capability run', () => {
  // signal-degraded fires only on capability TRANSITIONS within a
  // run. The matrix runs hold capabilities constant per profile, so
  // any signal-degraded emit is a bug — it would mean the tracker
  // is mis-detecting a degradation between identical snapshots.
  for (const [name, caps] of PROFILES) {
    const events = runFixture(caps)
    const noisy = events.filter(
      (e) => e.kind === 'signal-degraded' || e.kind === 'signal-recovered',
    )
    expect(noisy, `profile=${name} emitted ${noisy.length} stray signal events`).toEqual([])
  }
})
