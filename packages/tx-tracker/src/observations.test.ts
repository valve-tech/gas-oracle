/**
 * Unit tests for `observations.ts` — the pure decision functions.
 *
 * Every branch of the per-record state machine gets a dedicated test
 * with literal inputs. No async, no stub source, no shared mutable
 * state — each test is `decideXxxObservation(literal-input) →
 * expected-result`.
 *
 * Goes after the same coverage the integration tests in
 * `tracker.test.ts` already provide indirectly, but at much higher
 * signal-to-noise: a coverage gap here points at a specific decision
 * arm with a one-line repro.
 */
import { test, expect } from 'vitest'

import type { RawTx } from '@valve-tech/chain-source'

import { buildInitialStatus, type Hash, type TxStatus } from './events.js'
import {
  cacheIdentity,
  decideBlockObservation,
  decideMempoolObservation,
  findReplacementInBlock,
  type ReadonlyTrackedRecord,
} from './observations.js'

const CAPS = {
  newHeads: 'subscription' as const,
  newPendingTransactions: 'poll-only' as const,
  txpoolContent: 'available' as const,
  receiptByHash: 'available' as const,
  reprobeOnReconnect: true,
}

const ENVELOPE = { blockNumber: 100n, timestamp: 1_700_000_000n }

const makeRecord = (overrides: Partial<ReadonlyTrackedRecord> = {}): ReadonlyTrackedRecord => ({
  hash: '0xtracked',
  status: buildInitialStatus({
    hash: '0xtracked',
    chainId: 1,
    capabilities: CAPS,
  }),
  identity: null,
  inLastMempoolSnapshot: false,
  unseenThresholdBlocks: 30,
  ...overrides,
})

const withStatus = (
  base: ReadonlyTrackedRecord,
  patch: Partial<TxStatus>,
): ReadonlyTrackedRecord => ({
  ...base,
  status: { ...base.status, ...patch },
})

const txInBlock = (overrides: Partial<RawTx> = {}): RawTx => ({
  hash: '0xtracked',
  from: '0xs',
  nonce: '0x5',
  ...overrides,
})

const blockInput = (overrides: {
  txs?: RawTx[]
  blockHash?: Hash
  blockNumber?: bigint
  previousTipNumber?: bigint | null
  record?: ReadonlyTrackedRecord
} = {}) => {
  const txs = overrides.txs ?? [txInBlock()]
  const blockHash = overrides.blockHash ?? '0xb1'
  const blockNumber = overrides.blockNumber ?? 100n
  return {
    record: overrides.record ?? makeRecord(),
    blockHash,
    blockNumber,
    txHashSet: new Set<Hash>(txs.map((t) => t.hash!).filter(Boolean)),
    txs,
    chainId: 1,
    eventSource: 'block-poll' as const,
    envelope: ENVELOPE,
    previousTipNumber: overrides.previousTipNumber ?? null,
  }
}

// -------------------------------------------------------------
// decideBlockObservation — Path 1: hash is in this block
// -------------------------------------------------------------

test('block: fresh inclusion emits seen-in-block with confirmations=1', () => {
  const result = decideBlockObservation(blockInput())
  expect(result.events).toHaveLength(1)
  expect(result.events[0].kind).toBe('seen-in-block')
  if (result.events[0].kind === 'seen-in-block') {
    expect(result.events[0].confirmations).toBe(1)
    expect(result.events[0].blockNumber).toBe(100n)
    expect(result.events[0].transactionIndex).toBe(0)
  }
  expect(result.statusPatch.lastSeenInBlock?.confirmations).toBe(1)
  expect(result.statusPatch.unseenStreak).toBe(0)
  expect(result.statusPatch.firstObservedAtBlock).toBe(100n)
  expect(result.statusPatch.lastObservedAtBlock).toBe(100n)
})

test('block: fresh inclusion caches identity from the matched tx', () => {
  const result = decideBlockObservation(blockInput())
  expect(result.identityPatch).toEqual({ from: '0xs', nonce: '0x5' })
})

test('block: fresh inclusion does NOT overwrite already-cached identity', () => {
  const record = makeRecord({
    identity: { from: '0xprev', nonce: '0x99' },
  })
  const result = decideBlockObservation(blockInput({ record }))
  expect(result.identityPatch).toBeNull()
})

test('block: same-block re-observation (already at this blockHash) emits NO event', () => {
  const record = withStatus(makeRecord(), {
    lastSeenInBlock: {
      blockHash: '0xb1',
      blockNumber: 100n,
      transactionIndex: 0,
      confirmations: 5,
      source: 'block-poll',
    },
  })
  const result = decideBlockObservation(blockInput({ record }))
  expect(result.events).toEqual([])
  // confirmations preserved; not reset to 1
  expect(result.statusPatch.lastSeenInBlock?.confirmations).toBe(5)
})

test('block: defensive — txHashSet says yes but txs.find misses → empty result', () => {
  // Constructed-but-impossible state: hash in set, not in array.
  // The early-return defensive branch.
  const record = makeRecord()
  const result = decideBlockObservation({
    ...blockInput({ record }),
    txs: [], // empty txs
    txHashSet: new Set(['0xtracked']), // but set claims it's there
  })
  expect(result.events).toEqual([])
})

// -------------------------------------------------------------
// decideBlockObservation — Path 2: confirmation bump
// -------------------------------------------------------------

test('block: confirmation bump emits seen-in-block with incremented count', () => {
  const record = withStatus(makeRecord(), {
    lastSeenInBlock: {
      blockHash: '0xb-old',
      blockNumber: 99n,
      transactionIndex: 0,
      confirmations: 1,
      source: 'block-poll',
    },
    firstObservedAtBlock: 99n,
    lastObservedAtBlock: 99n,
  })
  const result = decideBlockObservation(
    blockInput({
      record,
      txs: [], // no inclusion in this block
      blockNumber: 100n,
      previousTipNumber: 99n,
    }),
  )
  expect(result.events).toHaveLength(1)
  if (result.events[0].kind === 'seen-in-block') {
    expect(result.events[0].confirmations).toBe(2)
    expect(result.events[0].blockNumber).toBe(99n) // original inclusion block
  }
  expect(result.statusPatch.lastSeenInBlock?.confirmations).toBe(2)
  expect(result.statusPatch.lastObservedAtBlock).toBe(100n)
})

test('block: NO confirmation bump on the first block (previousTipNumber is null)', () => {
  // Edge case: lastSeenInBlock somehow set on the first observed
  // block. Without a prior tip the bump path is gated off.
  const record = withStatus(makeRecord(), {
    lastSeenInBlock: {
      blockHash: '0xb-old',
      blockNumber: 99n,
      transactionIndex: 0,
      confirmations: 1,
      source: 'block-poll',
    },
  })
  const result = decideBlockObservation(
    blockInput({
      record,
      txs: [],
      previousTipNumber: null,
    }),
  )
  expect(result.events).toEqual([])
})

// -------------------------------------------------------------
// decideBlockObservation — Path 3: replacement detection
// -------------------------------------------------------------

test('block: replacement (different hash, same identity) emits replaced-by', () => {
  const record = makeRecord({
    identity: { from: '0xs', nonce: '0x5' },
    hash: '0xorig',
  })
  const result = decideBlockObservation(
    blockInput({
      record,
      txs: [
        { hash: '0xrep', from: '0xs', nonce: '0x5' },
        { hash: '0xother', from: '0xother', nonce: '0x1' },
      ],
    }),
  )
  expect(result.events).toHaveLength(1)
  if (result.events[0].kind === 'replaced-by') {
    expect(result.events[0].replacementHash).toBe('0xrep')
    expect(result.events[0].replacementBlockNumber).toBe(100n)
  }
  expect(result.statusPatch.replacedBy?.hash).toBe('0xrep')
})

test('block: replacement is case-insensitive on the from field', () => {
  const record = makeRecord({
    identity: { from: '0xAAA', nonce: '0x5' },
    hash: '0xorig',
  })
  const result = decideBlockObservation(
    blockInput({
      record,
      txs: [{ hash: '0xrep', from: '0xaaa', nonce: '0x5' }],
    }),
  )
  expect(result.events.some((e) => e.kind === 'replaced-by')).toBe(true)
})

test('block: replacement requires identity to be cached (else falls through to unseen)', () => {
  const record = withStatus(makeRecord({ hash: '0xorig' }), {
    firstObservedAtBlock: 50n,
  })
  // identity is null — replacement path skipped, unseen path fires
  const result = decideBlockObservation(
    blockInput({
      record,
      txs: [{ hash: '0xrep', from: '0xs', nonce: '0x5' }],
    }),
  )
  // Fell through to unseen-streak bump (firstObservedAtBlock is set)
  expect(result.statusPatch.unseenStreak).toBe(1)
  expect(result.events).toEqual([])
})

test('block: replacement requires hash on the candidate', () => {
  const record = makeRecord({
    identity: { from: '0xs', nonce: '0x5' },
    hash: '0xorig',
  })
  const result = decideBlockObservation(
    blockInput({
      record,
      txs: [{ from: '0xs', nonce: '0x5' }], // no hash
    }),
  )
  expect(result.events.some((e) => e.kind === 'replaced-by')).toBe(false)
})

// -------------------------------------------------------------
// decideBlockObservation — Path 4: truly unseen
// -------------------------------------------------------------

test('block: truly unseen with no prior observation emits NOTHING', () => {
  // No firstObservedAtBlock → brand-new subscription, the first
  // block it watches is not "unseen-since" anything.
  const record = makeRecord()
  const result = decideBlockObservation(
    blockInput({ record, txs: [] }),
  )
  expect(result.events).toEqual([])
  expect(result.statusPatch).toEqual({})
})

test('block: truly unseen WITH prior observation bumps streak', () => {
  const record = withStatus(makeRecord(), { firstObservedAtBlock: 50n })
  const result = decideBlockObservation(
    blockInput({ record, txs: [] }),
  )
  expect(result.statusPatch.unseenStreak).toBe(1)
  expect(result.events).toEqual([])
})

test('block: streak crossing threshold emits unseen-for-N-blocks', () => {
  const record = withStatus(makeRecord({ unseenThresholdBlocks: 3 }), {
    firstObservedAtBlock: 50n,
    unseenStreak: 2,
  })
  const result = decideBlockObservation(
    blockInput({ record, txs: [] }),
  )
  expect(result.statusPatch.unseenStreak).toBe(3)
  expect(result.events).toHaveLength(1)
  expect(result.events[0].kind).toBe('unseen-for-N-blocks')
  if (result.events[0].kind === 'unseen-for-N-blocks') {
    expect(result.events[0].blocks).toBe(3)
  }
})

test('block: streak above threshold does NOT re-emit (only on equality)', () => {
  const record = withStatus(makeRecord({ unseenThresholdBlocks: 3 }), {
    firstObservedAtBlock: 50n,
    unseenStreak: 5, // already past threshold
  })
  const result = decideBlockObservation(
    blockInput({ record, txs: [] }),
  )
  expect(result.statusPatch.unseenStreak).toBe(6)
  expect(result.events).toEqual([])
})

// -------------------------------------------------------------
// decideMempoolObservation
// -------------------------------------------------------------

const mempoolInput = (overrides: {
  presence?: { bucket: 'pending' | 'queued'; tx: RawTx } | null
  replacementInMempool?: RawTx | null
  record?: ReadonlyTrackedRecord
  tipBlockNumber?: bigint
} = {}) => ({
  record: overrides.record ?? makeRecord(),
  presence: overrides.presence ?? null,
  replacementInMempool: overrides.replacementInMempool ?? null,
  chainId: 1,
  eventSource: 'mempool-snapshot' as const,
  envelope: ENVELOPE,
  tipBlockNumber: overrides.tipBlockNumber ?? 100n,
})

test('mempool: first-time presence emits seen-in-mempool, sets in-mempool flag', () => {
  const tx = { hash: '0xtracked', from: '0xs', nonce: '0x5' }
  const result = decideMempoolObservation(
    mempoolInput({ presence: { bucket: 'pending', tx } }),
  )
  expect(result.events).toHaveLength(1)
  expect(result.events[0].kind).toBe('seen-in-mempool')
  expect(result.inMempoolPatch).toBe(true)
  expect(result.statusPatch.lastSeenInMempool?.bucket).toBe('pending')
  expect(result.identityPatch).toEqual({ from: '0xs', nonce: '0x5' })
})

test('mempool: same-bucket re-observation does NOT re-emit', () => {
  const record = withStatus(
    makeRecord({ inLastMempoolSnapshot: true }),
    {
      lastSeenInMempool: {
        bucket: 'pending',
        tx: { hash: '0xtracked' },
        at: ENVELOPE,
        source: 'mempool-snapshot',
      },
    },
  )
  const tx = { hash: '0xtracked', from: '0xs', nonce: '0x5' }
  const result = decideMempoolObservation(
    mempoolInput({ record, presence: { bucket: 'pending', tx } }),
  )
  expect(result.events.some((e) => e.kind === 'seen-in-mempool')).toBe(false)
  // But the snapshot is still updated
  expect(result.statusPatch.lastSeenInMempool?.bucket).toBe('pending')
})

test('mempool: bucket transition queued → pending re-emits', () => {
  const record = withStatus(
    makeRecord({ inLastMempoolSnapshot: true }),
    {
      lastSeenInMempool: {
        bucket: 'queued',
        tx: { hash: '0xtracked' },
        at: ENVELOPE,
        source: 'mempool-snapshot',
      },
    },
  )
  const tx = { hash: '0xtracked', from: '0xs', nonce: '0x5' }
  const result = decideMempoolObservation(
    mempoolInput({ record, presence: { bucket: 'pending', tx } }),
  )
  const seen = result.events.filter((e) => e.kind === 'seen-in-mempool')
  expect(seen).toHaveLength(1)
})

test('mempool: absence after presence emits left-mempool, clears in-mempool flag', () => {
  const record = makeRecord({ inLastMempoolSnapshot: true })
  const result = decideMempoolObservation(mempoolInput({ record }))
  expect(result.events).toHaveLength(1)
  expect(result.events[0].kind).toBe('left-mempool')
  expect(result.inMempoolPatch).toBe(false)
})

test('mempool: absence with no prior presence emits NOTHING', () => {
  const result = decideMempoolObservation(mempoolInput())
  expect(result.events).toEqual([])
  expect(result.inMempoolPatch).toBeNull()
})

test('mempool: replacement candidate fires replaced-by independently of presence', () => {
  const record = makeRecord({
    identity: { from: '0xs', nonce: '0x5' },
    hash: '0xorig',
  })
  const result = decideMempoolObservation(
    mempoolInput({
      record,
      replacementInMempool: { hash: '0xrep', from: '0xs', nonce: '0x5' },
    }),
  )
  expect(result.events.some((e) => e.kind === 'replaced-by')).toBe(true)
  expect(result.statusPatch.replacedBy?.hash).toBe('0xrep')
  expect(result.statusPatch.replacedBy?.blockNumber).toBeNull()
})

test('mempool: replacement skipped when replacedBy already recorded', () => {
  const record = withStatus(
    makeRecord({
      identity: { from: '0xs', nonce: '0x5' },
      hash: '0xorig',
    }),
    {
      replacedBy: { hash: '0xprev-rep', blockNumber: null },
    },
  )
  const result = decideMempoolObservation(
    mempoolInput({
      record,
      replacementInMempool: { hash: '0xnew-rep', from: '0xs', nonce: '0x5' },
    }),
  )
  expect(result.events.some((e) => e.kind === 'replaced-by')).toBe(false)
})

test('mempool: replacement requires identity to be cached', () => {
  const record = makeRecord({ identity: null, hash: '0xorig' })
  const result = decideMempoolObservation(
    mempoolInput({
      record,
      replacementInMempool: { hash: '0xrep', from: '0xs', nonce: '0x5' },
    }),
  )
  expect(result.events.some((e) => e.kind === 'replaced-by')).toBe(false)
})

test('mempool: replacement matching the original hash is skipped', () => {
  const record = makeRecord({
    identity: { from: '0xs', nonce: '0x5' },
    hash: '0xorig',
  })
  const result = decideMempoolObservation(
    mempoolInput({
      record,
      // Same hash as record — not a replacement
      replacementInMempool: { hash: '0xorig', from: '0xs', nonce: '0x5' },
    }),
  )
  expect(result.events.some((e) => e.kind === 'replaced-by')).toBe(false)
})

test('mempool: replacement candidate without hash is skipped', () => {
  const record = makeRecord({
    identity: { from: '0xs', nonce: '0x5' },
    hash: '0xorig',
  })
  const result = decideMempoolObservation(
    mempoolInput({
      record,
      replacementInMempool: { from: '0xs', nonce: '0x5' }, // no hash
    }),
  )
  expect(result.events.some((e) => e.kind === 'replaced-by')).toBe(false)
})

test('mempool: presence + replacement fire BOTH events on the same call', () => {
  const record = makeRecord({
    identity: { from: '0xs', nonce: '0x5' },
    hash: '0xtracked',
  })
  const tx = { hash: '0xtracked', from: '0xs', nonce: '0x5' }
  const result = decideMempoolObservation(
    mempoolInput({
      record,
      presence: { bucket: 'pending', tx },
      replacementInMempool: { hash: '0xrep', from: '0xs', nonce: '0x5' },
    }),
  )
  const kinds = result.events.map((e) => e.kind)
  expect(kinds).toContain('seen-in-mempool')
  expect(kinds).toContain('replaced-by')
})

// -------------------------------------------------------------
// findReplacementInBlock + cacheIdentity (helpers)
// -------------------------------------------------------------

test('findReplacementInBlock returns the first matching tx', () => {
  const result = findReplacementInBlock(
    { from: '0xs', nonce: '0x5' },
    '0xorig',
    [
      { hash: '0xother', from: '0xother', nonce: '0x5' },
      { hash: '0xrep', from: '0xs', nonce: '0x5' },
    ],
  )
  expect(result?.hash).toBe('0xrep')
})

test('findReplacementInBlock skips the original hash', () => {
  const result = findReplacementInBlock(
    { from: '0xs', nonce: '0x5' },
    '0xorig',
    [{ hash: '0xorig', from: '0xs', nonce: '0x5' }],
  )
  expect(result).toBeNull()
})

test('findReplacementInBlock skips txs missing from / nonce', () => {
  const result = findReplacementInBlock(
    { from: '0xs', nonce: '0x5' },
    '0xorig',
    [
      { hash: '0xrep1', nonce: '0x5' }, // no from
      { hash: '0xrep2', from: '0xs' }, // no nonce
    ],
  )
  expect(result).toBeNull()
})

test('findReplacementInBlock returns null when nothing matches', () => {
  expect(
    findReplacementInBlock({ from: '0xs', nonce: '0x5' }, '0xorig', []),
  ).toBeNull()
})

test('cacheIdentity: returns null when identity is already cached', () => {
  const result = cacheIdentity(
    { from: '0xprev', nonce: '0x99' },
    { from: '0xnew', nonce: '0x5' },
  )
  expect(result).toBeNull()
})

test('cacheIdentity: returns null when tx is missing from or nonce', () => {
  expect(cacheIdentity(null, { nonce: '0x5' })).toBeNull()
  expect(cacheIdentity(null, { from: '0xs' })).toBeNull()
})

test('cacheIdentity: returns the new identity when cache empty + tx complete', () => {
  expect(cacheIdentity(null, { from: '0xs', nonce: '0x5' })).toEqual({
    from: '0xs',
    nonce: '0x5',
  })
})
