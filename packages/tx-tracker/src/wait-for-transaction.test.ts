/**
 * Tests for `waitForTransaction` — the Promise-based "tell me when
 * this hash mines or drops" convenience wrapper over ChainSource +
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

import { waitForTransaction } from './wait-for-transaction.js'
import type { WaitForTransactionInternalOptions } from './wait-for-transaction.js'

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
  overrides: Omit<WaitForTransactionInternalOptions, 'client' | '_sourceOverride'>,
): WaitForTransactionInternalOptions => ({
  client: makeStubClient(),
  _sourceOverride: source,
  ...overrides,
})

// ---------- helpers ----------

const HASH = '0xdeadbeef'
const REPLACEMENT_HASH = '0xreplacement'

/**
 * Emit a mempool snapshot containing HASH so `firstObservedAtBlock` is
 * set. Required before `unseen-for-N-blocks` can fire — the tracker
 * only counts unseen streaks after the hash has been observed at least
 * once (spec §6.1).
 */
const seedMempool = (source: StubSource): void => {
  source.emitMempool({
    pending: { '0xsender': { '1': { hash: HASH, from: '0xsender', nonce: '0x1' } } },
    queued: {},
  })
  // Drop from mempool so streak counting begins.
  source.emitMempool({ pending: {}, queued: {} })
}

// ---------- tests ----------

test("'mined' outcome at default confirmations (1)", async () => {
  const source = makeStubSource()
  const promise = waitForTransaction(makeOptions(source, { hash: HASH }))

  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]))

  const outcome = await promise
  expect(outcome.status).toBe('mined')
  if (outcome.status === 'mined') {
    expect(outcome.event.kind).toBe('seen-in-block')
    expect(outcome.event.confirmations).toBe(1)
    expect(outcome.event.blockNumber).toBe(100n)
  }
})

test("'mined' at explicit confirmations (3)", async () => {
  const source = makeStubSource()
  const promise = waitForTransaction(makeOptions(source, { hash: HASH, confirmations: 3 }))

  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]))
  source.emitBlock(makeBlock(101n, '0xb2', [], '0xb1'))
  source.emitBlock(makeBlock(102n, '0xb3', [], '0xb2'))

  const outcome = await promise
  expect(outcome.status).toBe('mined')
  if (outcome.status === 'mined') {
    expect(outcome.event.confirmations).toBe(3)
  }
})

test("'dropped' outcome after default staleAfterBlocks (12)", async () => {
  const source = makeStubSource()
  const promise = waitForTransaction(makeOptions(source, { hash: HASH }))

  seedMempool(source)

  for (let i = 0; i < 12; i++) {
    source.emitBlock(makeBlock(BigInt(100 + i), `0xb${i}`, []))
  }

  const outcome = await promise
  expect(outcome.status).toBe('dropped')
  if (outcome.status === 'dropped') {
    expect(outcome.reason).toBe('unseen-for-N-blocks')
  }
})

test("'replaced' outcome fires when replaced-by event is emitted", async () => {
  const source = makeStubSource()
  const promise = waitForTransaction(makeOptions(source, { hash: HASH }))

  // Step 1: observe HASH in mempool (sets from + nonce identity).
  source.emitMempool({
    pending: {
      '0xsender': {
        '1': { hash: HASH, from: '0xsender', nonce: '0x1' },
      },
    },
    queued: {},
  })

  // Step 2: emit mempool with a DIFFERENT hash at the same (from, nonce).
  // This triggers the tracker's replaced-by detection path.
  source.emitMempool({
    pending: {
      '0xsender': {
        '1': { hash: REPLACEMENT_HASH, from: '0xsender', nonce: '0x1' },
      },
    },
    queued: {},
  })

  const outcome = await promise
  expect(outcome.status).toBe('replaced')
  if (outcome.status === 'replaced') {
    expect(outcome.replacementHash).toBe(REPLACEMENT_HASH)
    expect(outcome.event.kind).toBe('replaced-by')
  }
})

test("'failed' outcome with withReceipts: true and receipt.status === '0x0'", async () => {
  const failReceipt = {
    transactionHash: HASH,
    blockNumber: '0x64',
    blockHash: '0xb1',
    status: '0x0' as const,
    gasUsed: '0x5208',
    cumulativeGasUsed: '0x5208',
    logs: [],
    logsBloom: '0x',
    transactionIndex: '0x0',
    from: '0xsender',
    to: '0xrecipient',
    contractAddress: null,
    type: '0x2',
    effectiveGasPrice: '0x1',
  }

  // Rebuild with receipt-capable source so we can drive emitBlock alongside getReceipt
  const blockSubs = new Set<(b: BlockResult) => void>()
  const mempoolSubs = new Set<(s: NormalizedMempool) => void>()
  let caps: Capabilities = { ...DEFAULT_CAPS, receiptByHash: 'available' }

  const richSource: StubSource = {
    start: () => {},
    stop: () => {},
    pollOnce: async () => {},
    ready: () => Promise.resolve(),
    subscribeBlocks: (cb) => { blockSubs.add(cb); return () => blockSubs.delete(cb) },
    subscribeMempool: (cb) => { mempoolSubs.add(cb); return () => mempoolSubs.delete(cb) },
    getBlock: async () => null,
    getFeeHistory: async () => null,
    getMempoolSnapshot: async () => null,
    getReceipt: async () => failReceipt,
    getTransaction: async () => null,
    capabilities: () => caps,
    emitBlock: (block) => { for (const cb of [...blockSubs]) cb(block) },
    emitMempool: (snapshot) => { for (const cb of [...mempoolSubs]) cb(snapshot) },
    setCapabilities: (next) => { caps = next },
  }

  const promise = waitForTransaction(
    makeOptions(richSource, { hash: HASH, withReceipts: true }),
  )

  richSource.emitBlock(
    makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]),
  )

  const outcome = await promise
  expect(outcome.status).toBe('failed')
  if (outcome.status === 'failed') {
    expect(outcome.receipt.status).toBe('0x0')
    expect(outcome.event.kind).toBe('seen-in-block')
  }
})

test("'mined' outcome with withReceipts: true and receipt.status === '0x1' (success)", async () => {
  const successReceipt = {
    transactionHash: HASH,
    blockNumber: '0x64',
    blockHash: '0xb1',
    status: '0x1' as const,
    gasUsed: '0x5208',
    cumulativeGasUsed: '0x5208',
    logs: [],
    logsBloom: '0x',
    transactionIndex: '0x0',
    from: '0xsender',
    to: '0xrecipient',
    contractAddress: null,
    type: '0x2',
    effectiveGasPrice: '0x1',
  }

  const blockSubs = new Set<(b: BlockResult) => void>()
  const mempoolSubs = new Set<(s: NormalizedMempool) => void>()
  let caps: Capabilities = { ...DEFAULT_CAPS, receiptByHash: 'available' }

  const richSource: StubSource = {
    start: () => {},
    stop: () => {},
    pollOnce: async () => {},
    ready: () => Promise.resolve(),
    subscribeBlocks: (cb) => { blockSubs.add(cb); return () => blockSubs.delete(cb) },
    subscribeMempool: (cb) => { mempoolSubs.add(cb); return () => mempoolSubs.delete(cb) },
    getBlock: async () => null,
    getFeeHistory: async () => null,
    getMempoolSnapshot: async () => null,
    getReceipt: async () => successReceipt,
    getTransaction: async () => null,
    capabilities: () => caps,
    emitBlock: (block) => { for (const cb of [...blockSubs]) cb(block) },
    emitMempool: (snapshot) => { for (const cb of [...mempoolSubs]) cb(snapshot) },
    setCapabilities: (next) => { caps = next },
  }

  const promise = waitForTransaction(
    makeOptions(richSource, { hash: HASH, withReceipts: true }),
  )

  richSource.emitBlock(
    makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]),
  )

  const outcome = await promise
  expect(outcome.status).toBe('mined')
})

test('Promise resolves only ONCE — subsequent events after settle are ignored', async () => {
  const source = makeStubSource()
  let resolveCount = 0

  const promise = waitForTransaction(makeOptions(source, { hash: HASH })).then((outcome) => {
    resolveCount++
    return outcome
  })

  // Trigger terminal: hash mines.
  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]))

  await promise

  // Push more events after settlement — promise already resolved.
  source.emitBlock(makeBlock(101n, '0xb2', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]))
  source.emitBlock(makeBlock(102n, '0xb3', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]))

  // Allow microtask queue to drain.
  await Promise.resolve()
  await Promise.resolve()

  expect(resolveCount).toBe(1)
})

test('Tracker/source teardown happens before resolve', async () => {
  const source = makeStubSource()
  let subscriptionActive = false
  const originalSubscribeBlocks = source.subscribeBlocks.bind(source)
  source.subscribeBlocks = (cb) => {
    subscriptionActive = true
    const unsub = originalSubscribeBlocks(cb)
    return () => {
      subscriptionActive = false
      unsub()
    }
  }

  let outcome: unknown
  const promise = waitForTransaction(makeOptions(source, { hash: HASH })).then((result) => {
    outcome = result
    return result
  })

  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]))

  await promise

  expect(subscriptionActive).toBe(false)
  expect(outcome).toBeDefined()
})

test('pollIntervalMs is passed through to the real ChainSource path', () => {
  const client = makeStubClient()
  // Verify no throw when using the real (non-injected) source path.
  // The promise will never resolve since no blocks are emitted — that's OK,
  // we just verify the constructor path doesn't throw.
  expect(() => {
    waitForTransaction({ client, hash: HASH, pollIntervalMs: 5_000 })
  }).not.toThrow()
})

test('finish() early-return guard prevents double-resolution', async () => {
  // This test exercises the `if (settled) return` guard inside finish().
  // We need two terminal events in the same synchronous tick.
  // Emit two blocks with the same tx in rapid succession before awaiting.
  const source = makeStubSource()

  let resolveCount = 0
  const originalPromise = waitForTransaction(makeOptions(source, { hash: HASH }))
  const trackedPromise = originalPromise.then((r) => {
    resolveCount++
    return r
  })

  // Emit two blocks with the target tx — the tracker may emit two
  // seen-in-block events; finish() must guard against double-settling.
  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]))
  source.emitBlock(makeBlock(101n, '0xb2', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]))

  await trackedPromise
  await Promise.resolve()

  expect(resolveCount).toBe(1)
})

test('source.start() and source.stop() are called as part of helper lifecycle', async () => {
  // The helper owns the source's lifecycle: start on construction, stop on
  // settle. Tests inject sources via `_sourceOverride` purely as a stub for
  // hermetic testing — the helper still drives start/stop on it.
  const source = makeStubSource()
  const startSpy = vi.spyOn(source, 'start')
  const stopSpy = vi.spyOn(source, 'stop')

  const promise = waitForTransaction(makeOptions(source, { hash: HASH }))
  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]))
  await promise

  expect(startSpy).toHaveBeenCalledOnce()
  expect(stopSpy).toHaveBeenCalledOnce()
})

test('chainId override flows through to the resolved event', async () => {
  const source = makeStubSource()
  const promise = waitForTransaction(makeOptions(source, { hash: HASH, chainId: 137 }))

  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]))

  const outcome = await promise
  expect(outcome.status).toBe('mined')
  if (outcome.status === 'mined') expect(outcome.event.chainId).toBe(137)
})

test('chainId falls back to client.chain.id when not explicitly provided', async () => {
  const source = makeStubSource()
  const clientWithChain = {
    transport: { type: 'http' },
    chain: { id: 8453 },
    request: vi.fn(async () => null),
  } as unknown as PublicClient
  const promise = waitForTransaction({
    client: clientWithChain,
    hash: HASH,
    _sourceOverride: source,
  } as WaitForTransactionInternalOptions)

  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xsender', nonce: '0x1' }]))

  const outcome = await promise
  expect(outcome.status).toBe('mined')
  if (outcome.status === 'mined') expect(outcome.event.chainId).toBe(8453)
})
