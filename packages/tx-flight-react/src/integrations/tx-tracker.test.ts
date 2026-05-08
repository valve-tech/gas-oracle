import { test, expect, vi } from 'vitest'
import type { PublicClient } from 'viem'
import type {
  BlockResult,
  Capabilities,
  ChainSource,
  FeeHistoryResult,
  NormalizedMempool,
  RawTx,
  TransactionReceipt,
} from '@valve-tech/chain-source'

import { createTxFlightStore } from '../store/store.js'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { addByHashImpl, resumeByHashWatcher } from './tx-tracker.js'

// ─── stub ChainSource (mirrors watch-transaction.test.ts) ────────────────

interface StubSource extends ChainSource {
  emitBlock: (block: BlockResult) => void
  emitMempool: (snapshot: NormalizedMempool) => void
  isStopped: () => boolean
}

const DEFAULT_CAPS: Capabilities = {
  newHeads: 'poll-only',
  newPendingTransactions: 'poll-only',
  txpoolContent: 'gated',
  receiptByHash: 'available',
  reprobeOnReconnect: false,
}

const makeStubSource = (
  receipts: Map<string, TransactionReceipt> = new Map(),
): StubSource => {
  const blockSubs = new Set<(b: BlockResult) => void>()
  const mempoolSubs = new Set<(s: NormalizedMempool) => void>()
  let stopped = false
  return {
    start: () => undefined,
    stop: () => {
      stopped = true
    },
    pollOnce: async () => undefined,
    ready: () => Promise.resolve(),
    subscribeBlocks: (cb) => {
      blockSubs.add(cb)
      return () => {
        blockSubs.delete(cb)
      }
    },
    subscribeMempool: (cb) => {
      mempoolSubs.add(cb)
      return () => {
        mempoolSubs.delete(cb)
      }
    },
    getBlock: async (): Promise<BlockResult | null> => null,
    getFeeHistory: async (): Promise<FeeHistoryResult | null> => null,
    getMempoolSnapshot: async (): Promise<NormalizedMempool | null> => null,
    getReceipt: async (hash: string): Promise<TransactionReceipt | null> =>
      receipts.get(hash) ?? null,
    getTransaction: async (): Promise<RawTx | null> => null,
    capabilities: () => DEFAULT_CAPS,
    emitBlock: (block) => {
      for (const cb of [...blockSubs]) cb(block)
    },
    emitMempool: (snapshot) => {
      for (const cb of [...mempoolSubs]) cb(snapshot)
    },
    isStopped: () => stopped,
  }
}

const makeStubClient = (): PublicClient =>
  ({
    transport: { type: 'http' },
    request: vi.fn(async () => null),
  } as unknown as PublicClient)

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

const HASH = '0xdeadbeef'
const REPLACEMENT = '0xfeedface'

const makeStore = () =>
  createTxFlightStore({ maxItems: 50, terminalRetentionMs: 60_000 })

const seedMempool = (source: StubSource): void => {
  // Emit then drop so unseen-for-N-blocks counting can begin.
  source.emitMempool({
    pending: { '0xs': { '1': { hash: HASH, from: '0xs', nonce: '0x1' } } },
    queued: {},
  })
  source.emitMempool({ pending: {}, queued: {} })
}

// ─── happy paths ─────────────────────────────────────────────────────────

test('addByHashImpl seeds an initial pending-status TrackedTx and returns its id', async () => {
  const store = makeStore()
  const source = makeStubSource()
  const id = await addByHashImpl(
    store,
    { hash: HASH, chainId: 1, client: makeStubClient() },
    undefined,
    { _sourceOverride: source },
  )
  const tx = store.getState().txs.get(id)
  expect(tx?.status).toBe('pending')
  expect(tx?.hash).toBe(HASH)
  expect(tx?.chainId).toBe(1)
  expect(tx?.flow).toBe('unknown')
})

test('honors flow input', async () => {
  const store = makeStore()
  const source = makeStubSource()
  const id = await addByHashImpl(
    store,
    { hash: HASH, chainId: 1, client: makeStubClient(), flow: 'swap' },
    undefined,
    { _sourceOverride: source },
  )
  expect(store.getState().txs.get(id)?.flow).toBe('swap')
})

// ─── lifecycle transitions ───────────────────────────────────────────────

test('seen-in-block transitions pending → confirmed at default 1 confirmation', async () => {
  const store = makeStore()
  const source = makeStubSource()
  const id = await addByHashImpl(
    store,
    { hash: HASH, chainId: 1, client: makeStubClient() },
    undefined,
    { _sourceOverride: source },
  )
  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xs', nonce: '0x1' }]))
  expect(store.getState().txs.get(id)?.status).toBe('confirmed')
})

test('seen-in-block respects custom confirmations threshold', async () => {
  const store = makeStore()
  const source = makeStubSource()
  const id = await addByHashImpl(
    store,
    { hash: HASH, chainId: 1, client: makeStubClient(), confirmations: 3 },
    undefined,
    { _sourceOverride: source },
  )
  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xs', nonce: '0x1' }]))
  expect(store.getState().txs.get(id)?.status).toBe('pending')
  source.emitBlock(makeBlock(101n, '0xb2', [], '0xb1'))
  source.emitBlock(makeBlock(102n, '0xb3', [], '0xb2'))
  expect(store.getState().txs.get(id)?.status).toBe('confirmed')
})

test('seen-in-block with reverted receipt → failed (when withReceipts: true)', async () => {
  const reverted: TransactionReceipt = {
    transactionHash: HASH,
    status: 'reverted',
    blockHash: '0xb1',
    blockNumber: '0x64',
    transactionIndex: '0x0',
    from: '0xs',
    to: '0xt',
    cumulativeGasUsed: '0x0',
    effectiveGasPrice: '0x0',
    gasUsed: '0x0',
    contractAddress: null,
    logs: [],
    logsBloom: '0x' + '0'.repeat(512),
    type: '0x2',
  } as unknown as TransactionReceipt
  const source = makeStubSource(new Map([[HASH, reverted]]))
  const store = makeStore()
  const id = await addByHashImpl(
    store,
    { hash: HASH, chainId: 1, client: makeStubClient(), withReceipts: true },
    undefined,
    { _sourceOverride: source },
  )
  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xs', nonce: '0x1' }]))
  // Receipt fetch is async; flush microtasks.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const tx = store.getState().txs.get(id)
  expect(tx?.status).toBe('failed')
  expect(tx?.notes).toBe('Transaction reverted')
})

test('replaced-by → status replaced + replacedBy hash', async () => {
  const store = makeStore()
  const source = makeStubSource()
  const id = await addByHashImpl(
    store,
    { hash: HASH, chainId: 1, client: makeStubClient() },
    undefined,
    { _sourceOverride: source },
  )
  // Replacement scenario: tx with same (from, nonce) mined.
  source.emitMempool({
    pending: { '0xs': { '1': { hash: HASH, from: '0xs', nonce: '0x1' } } },
    queued: {},
  })
  source.emitBlock(
    makeBlock(100n, '0xb1', [{ hash: REPLACEMENT, from: '0xs', nonce: '0x1' }]),
  )
  const tx = store.getState().txs.get(id)
  expect(tx?.status).toBe('replaced')
  expect(tx?.replacedBy).toBe(REPLACEMENT)
})

test('unseen-for-N-blocks → dropped at staleAfterBlocks', async () => {
  const store = makeStore()
  const source = makeStubSource()
  const id = await addByHashImpl(
    store,
    {
      hash: HASH,
      chainId: 1,
      client: makeStubClient(),
      staleAfterBlocks: 2,
    },
    undefined,
    { _sourceOverride: source },
  )
  seedMempool(source)
  // Two unseen blocks.
  source.emitBlock(makeBlock(100n, '0xb1', []))
  source.emitBlock(makeBlock(101n, '0xb2', [], '0xb1'))
  expect(store.getState().txs.get(id)?.status).toBe('dropped')
})

test('vanished-from-block reverts confirmed → pending after reorg', async () => {
  const store = makeStore()
  const source = makeStubSource()
  const id = await addByHashImpl(
    store,
    { hash: HASH, chainId: 1, client: makeStubClient() },
    undefined,
    { _sourceOverride: source },
  )
  // Mined into 100/0xb1.
  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xs', nonce: '0x1' }]))
  expect(store.getState().txs.get(id)?.status).toBe('confirmed')
  // Reorg: a different block at height 100 takes over (parent matches),
  // and the tx is NOT in it.
  source.emitBlock(makeBlock(100n, '0xb1-alt', [], '0xparent'))
  expect(store.getState().txs.get(id)?.status).toBe('pending')
})

test('seen-in-mempool keeps status pending (idempotent)', async () => {
  const store = makeStore()
  const source = makeStubSource()
  const id = await addByHashImpl(
    store,
    { hash: HASH, chainId: 1, client: makeStubClient() },
    undefined,
    { _sourceOverride: source },
  )
  source.emitMempool({
    pending: { '0xs': { '1': { hash: HASH, from: '0xs', nonce: '0x1' } } },
    queued: {},
  })
  expect(store.getState().txs.get(id)?.status).toBe('pending')
})

// ─── teardown ─────────────────────────────────────────────────────────────

test('store.remove(id) cancels the watcher subscription', async () => {
  const store = makeStore()
  const source = makeStubSource()
  const id = await addByHashImpl(
    store,
    { hash: HASH, chainId: 1, client: makeStubClient() },
    undefined,
    { _sourceOverride: source },
  )
  store.dispatch.remove(id)
  // Subsequent block emission should not try to update the (now removed) tx.
  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xs', nonce: '0x1' }]))
  expect(store.getState().txs.has(id)).toBe(false)
})

// ─── resumeByHashWatcher (rehydrate path) ─────────────────────────────────

const persistedTx = (overrides: Partial<TrackedTx> = {}): TrackedTx => ({
  id: 'persisted',
  hash: HASH,
  chainId: 1,
  flow: 'send',
  submittedAt: 1_000_000,
  submittedTier: 'standard',
  status: 'pending',
  ...overrides,
})

test('resumeByHashWatcher attaches a watcher that advances the existing tx', async () => {
  const store = makeStore()
  const tx = persistedTx()
  store.dispatch.addWithTx(tx, null)
  const source = makeStubSource()
  await resumeByHashWatcher(store, tx, makeStubClient(), undefined, {
    _sourceOverride: source,
  })
  source.emitBlock(makeBlock(100n, '0xb1', [{ hash: HASH, from: '0xs', nonce: '0x1' }]))
  expect(store.getState().txs.get('persisted')?.status).toBe('confirmed')
})

test('resumeByHashWatcher is a no-op when tx.hash is undefined', async () => {
  const store = makeStore()
  const tx = persistedTx({ hash: undefined })
  store.dispatch.addWithTx(tx, null)
  await resumeByHashWatcher(store, tx, makeStubClient(), undefined)
  // Watcher map should not have an entry — no subscribe happened.
  expect(store.getState().watchers.has('persisted')).toBe(false)
})

test('resumeByHashWatcher routes subscribeWatcher failures to onError', async () => {
  const store = makeStore()
  const tx = persistedTx()
  store.dispatch.addWithTx(tx, null)
  // Inject a stub source whose `start` throws — subscribeWatcher
  // surfaces that as a rejected promise; resumeByHashWatcher
  // swallows + routes to onError.
  const blowUp = makeStubSource()
  blowUp.start = () => { throw new Error('source kaboom') }
  const onError = vi.fn()
  await resumeByHashWatcher(store, tx, makeStubClient(), onError, {
    _sourceOverride: blowUp,
  })
  expect(onError).toHaveBeenCalledOnce()
  expect(onError.mock.calls[0]?.[0]).toBe('rehydrate-watcher')
  expect(store.getState().watchers.has('persisted')).toBe(false)
})

test('resumeByHashWatcher tears down its subscription if the tx was removed before subscribe resolved', async () => {
  const store = makeStore()
  const tx = persistedTx()
  store.dispatch.addWithTx(tx, null)
  const source = makeStubSource()
  // Kick off the resume; remove the tx synchronously before the
  // dynamic import settles.
  const promise = resumeByHashWatcher(store, tx, makeStubClient(), undefined, {
    _sourceOverride: source,
  })
  store.dispatch.remove('persisted')
  await promise
  // Once resolved, the tx is still gone (resume detected and bailed).
  expect(store.getState().txs.has('persisted')).toBe(false)
  // And the subscribe-then-unsubscribe path didn't accidentally
  // re-add the entry via overwriteWith addWithTx.
})

test('without _sourceOverride, the ChainSource is created and stopped on teardown', async () => {
  // Prove the ownsSource branch by NOT passing _sourceOverride.
  // The dynamic-imported real createChainSource is used. We can't drive
  // events through it (no live RPC), but we can prove construction
  // succeeds and teardown runs without throwing.
  const store = makeStore()
  const id = await addByHashImpl(store, {
    hash: HASH,
    chainId: 1,
    client: makeStubClient(),
  })
  expect(store.getState().txs.get(id)?.status).toBe('pending')
  expect(() => store.dispatch.remove(id)).not.toThrow()
})
