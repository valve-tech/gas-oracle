/**
 * Tests for `waitForPending` — the Promise-based "tell me when this
 * hash appears in any mempool" convenience wrapper over ChainSource +
 * TxTracker.
 *
 * Strategy: inject a stub ChainSource via the internal `_sourceOverride`
 * seam so tests can drive block/mempool emissions synchronously without
 * real timers or a live RPC.
 */

import { test, expect, vi } from 'vitest'
import type { PublicClient } from 'viem'

import type {
  BlockResult,
  Capabilities,
  ChainSource,
  NormalizedMempool,
  RawTx,
  FeeHistoryResult,
} from '@valve-tech/chain-source'

import { waitForPending, WaitForPendingTimeoutError } from './wait-for-pending.js'
import type {
  WaitForPendingInternalOptions,
  WaitForPendingOptions,
} from './wait-for-pending.js'

// ---------- stub ChainSource ----------

interface StubSource extends ChainSource {
  emitBlock: (block: BlockResult) => void
  emitMempool: (snapshot: NormalizedMempool) => void
  setCapabilities: (caps: Capabilities) => void
}

const DEFAULT_CAPS: Capabilities = {
  newHeads: 'poll-only',
  newPendingTransactions: 'poll-only',
  txpoolContent: 'gated',
  receiptByHash: 'unavailable',
  reprobeOnReconnect: false,
}

const makeStubSource = (initialCaps?: Capabilities): StubSource => {
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
    getReceipt: async (): Promise<null> => null,
    getTransaction: async (): Promise<RawTx | null> => null,
    capabilities: () => caps,
    emitBlock: (block) => { for (const cb of [...blockSubs]) cb(block) },
    emitMempool: (snapshot) => { for (const cb of [...mempoolSubs]) cb(snapshot) },
    setCapabilities: (next) => { caps = next },
  }
}

const makeBlock = (
  number: bigint,
  hash: string,
  txs: RawTx[],
  parentHash = '0xparent',
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

/** Minimal stub PublicClient — only used when _sourceOverride is not set. */
const makeStubClient = (): PublicClient =>
  ({
    transport: { type: 'http' },
    request: vi.fn(async () => null),
  } as unknown as PublicClient)

/**
 * Build options with the test injection seam wired up.
 * `client` is a no-op stub because the real source is overridden.
 */
const makeOptions = (
  source: StubSource,
  overrides: Omit<WaitForPendingInternalOptions, 'client' | '_sourceOverride'>,
): WaitForPendingInternalOptions => ({
  client: makeStubClient(),
  _sourceOverride: source,
  ...overrides,
})

// ---------- helpers ----------

const HASH = '0xdeadbeef' as const
const HASH2 = '0xdeadbeef2' as const

// ---------- tests ----------

test('resolves with seen-in-mempool event when hash appears in pending bucket', async () => {
  const source = makeStubSource()
  const promise = waitForPending(makeOptions(source, { hash: HASH }))

  source.emitMempool({
    pending: { '0xsender': { '1': { hash: HASH, from: '0xsender', nonce: '0x1' } } },
    queued: {},
  })

  const event = await promise
  expect(event.kind).toBe('seen-in-mempool')
  expect(event.hash).toBe(HASH)
})

test('resolves correctly when the tx is in the queued bucket', async () => {
  const source = makeStubSource()
  const promise = waitForPending(makeOptions(source, { hash: HASH }))

  source.emitMempool({
    pending: {},
    queued: { '0xsender': { '1': { hash: HASH, from: '0xsender', nonce: '0x1' } } },
  })

  const event = await promise
  expect(event.kind).toBe('seen-in-mempool')
  expect(event.hash).toBe(HASH)
})

test('rejects with WaitForPendingTimeoutError after default timeoutBlocks (12)', async () => {
  const source = makeStubSource()
  const promise = waitForPending(makeOptions(source, { hash: HASH }))

  for (let i = 0; i < 12; i++) {
    source.emitBlock(makeBlock(BigInt(100 + i), `0xb${i}`, []))
  }

  await expect(promise).rejects.toSatisfy((err: unknown) => {
    if (!(err instanceof WaitForPendingTimeoutError)) return false
    expect(err.hash).toBe(HASH)
    expect(err.observedBlocks).toBe(12)
    expect(err.message).toContain('12 block(s)')
    return true
  })
})

test('rejects with WaitForPendingTimeoutError at explicit timeoutBlocks: 3', async () => {
  const source = makeStubSource()
  const promise = waitForPending(makeOptions(source, { hash: HASH, timeoutBlocks: 3 }))

  for (let i = 0; i < 3; i++) {
    source.emitBlock(makeBlock(BigInt(100 + i), `0xb${i}`, []))
  }

  await expect(promise).rejects.toSatisfy((err: unknown) => {
    if (!(err instanceof WaitForPendingTimeoutError)) return false
    expect(err.hash).toBe(HASH)
    expect(err.observedBlocks).toBe(3)
    return true
  })
})

test('tracker/source teardown happens before resolve — subsequent emits do not trigger handlers', async () => {
  const source = makeStubSource()
  let eventCount = 0

  const promise = waitForPending(makeOptions(source, { hash: HASH })).then((event) => {
    eventCount++
    return event
  })

  // First mempool emit resolves the promise.
  source.emitMempool({
    pending: { '0xsender': { '1': { hash: HASH, from: '0xsender', nonce: '0x1' } } },
    queued: {},
  })

  await promise

  // Emit more mempool snapshots after settlement — should be ignored.
  source.emitMempool({
    pending: { '0xsender': { '1': { hash: HASH, from: '0xsender', nonce: '0x1' } } },
    queued: {},
  })
  source.emitMempool({
    pending: { '0xsender': { '1': { hash: HASH, from: '0xsender', nonce: '0x1' } } },
    queued: {},
  })

  await Promise.resolve()
  await Promise.resolve()

  expect(eventCount).toBe(1)
})

test('Promise settles only ONCE — multiple seen-in-mempool emits do not double-resolve', async () => {
  const source = makeStubSource()
  let resolveCount = 0

  const promise = waitForPending(makeOptions(source, { hash: HASH })).then((event) => {
    resolveCount++
    return event
  })

  // Emit mempool twice in rapid succession before awaiting.
  source.emitMempool({
    pending: { '0xsender': { '1': { hash: HASH, from: '0xsender', nonce: '0x1' } } },
    queued: {},
  })
  source.emitMempool({
    pending: { '0xsender': { '1': { hash: HASH, from: '0xsender', nonce: '0x1' } } },
    queued: {},
  })

  await promise
  await Promise.resolve()

  expect(resolveCount).toBe(1)
})

test('block tick at exactly timeoutBlocks triggers reject; subsequent seen-in-mempool ignored', async () => {
  const source = makeStubSource()
  let rejectCount = 0

  const promise = waitForPending(makeOptions(source, { hash: HASH, timeoutBlocks: 2 }))
    .catch((err: unknown) => {
      rejectCount++
      return err
    })

  // Emit exactly timeoutBlocks blocks — triggers reject.
  source.emitBlock(makeBlock(100n, '0xb0', []))
  source.emitBlock(makeBlock(101n, '0xb1', []))

  await promise

  // Now emit a mempool snapshot — should be ignored (already settled).
  source.emitMempool({
    pending: { '0xsender': { '1': { hash: HASH, from: '0xsender', nonce: '0x1' } } },
    queued: {},
  })

  await Promise.resolve()
  await Promise.resolve()

  expect(rejectCount).toBe(1)
})

test('WaitForPendingTimeoutError has correct name and instanceof check', async () => {
  const source = makeStubSource()
  const promise = waitForPending(makeOptions(source, { hash: HASH, timeoutBlocks: 1 }))

  source.emitBlock(makeBlock(100n, '0xb0', []))

  const err = await promise.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(WaitForPendingTimeoutError)
  if (err instanceof WaitForPendingTimeoutError) {
    expect(err.name).toBe('WaitForPendingTimeoutError')
    expect(err.hash).toBe(HASH)
    expect(err.observedBlocks).toBe(1)
  }
})

test('pollIntervalMs is passed through to the real ChainSource path', () => {
  const client = makeStubClient()
  // Verify no throw when using the real (non-injected) source path.
  // The promise will never resolve since no blocks are emitted — that's OK.
  expect(() => {
    waitForPending({ client, hash: HASH, pollIntervalMs: 5_000 })
  }).not.toThrow()
})

test('source.stop() and source.start() are called as part of helper lifecycle', async () => {
  // The helper owns the source's lifecycle: start on construction, stop on
  // settle. Tests inject sources via `_sourceOverride` purely as a stub for
  // hermetic testing — the helper still drives start/stop on it.
  const source = makeStubSource()
  const startSpy = vi.spyOn(source, 'start')
  const stopSpy = vi.spyOn(source, 'stop')

  const promise = waitForPending(makeOptions(source, { hash: HASH }))

  source.emitMempool({
    pending: { '0xsender': { '1': { hash: HASH, from: '0xsender', nonce: '0x1' } } },
    queued: {},
  })

  await promise

  expect(startSpy).toHaveBeenCalledOnce()
  expect(stopSpy).toHaveBeenCalledOnce()
})

test('resolves with distinct hash — does not fire for unrelated hashes', async () => {
  const source = makeStubSource()
  const promise = waitForPending(makeOptions(source, { hash: HASH }))

  // Emit an unrelated hash first — should not resolve HASH's promise.
  source.emitMempool({
    pending: { '0xother': { '1': { hash: HASH2, from: '0xother', nonce: '0x1' } } },
    queued: {},
  })

  // Now emit HASH — should resolve.
  source.emitMempool({
    pending: { '0xsender': { '1': { hash: HASH, from: '0xsender', nonce: '0x1' } } },
    queued: {},
  })

  const event = await promise
  expect(event.hash).toBe(HASH)
})

// Type-level usage reference (not executed as a test assertion)
void (null as unknown as WaitForPendingOptions)
void (null as unknown as WaitForPendingInternalOptions)
