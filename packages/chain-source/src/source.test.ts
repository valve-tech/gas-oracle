import { test, expect, vi } from 'vitest'
import type { PublicClient } from 'viem'

import { createChainSource } from './source.js'
import type {
  BlockResult,
  FeeHistoryResult,
  NormalizedMempool,
  RawTx,
  TransactionReceipt,
  TxPoolContent,
} from './types.js'

interface RpcCall {
  method: string
  params: unknown[]
}

interface FakeClientOptions {
  transport?: { type: string; subscribe?: unknown }
  responses?: Partial<Record<string, () => unknown>>
}

const fakeClient = (
  opts: FakeClientOptions = {},
): { client: PublicClient; calls: RpcCall[] } => {
  const calls: RpcCall[] = []
  const responses = opts.responses ?? {}
  const client = {
    transport: opts.transport ?? { type: 'http' },
    request: vi.fn(async ({ method, params }: RpcCall) => {
      calls.push({ method, params })
      const responder = responses[method]
      if (!responder) return null
      return responder()
    }),
  } as unknown as PublicClient
  return { client, calls }
}

const sampleBlock = (number: string): BlockResult => ({
  number,
  hash: '0xblock',
  parentHash: '0xparent',
  timestamp: '0x1',
  baseFeePerGas: '0x7',
  gasLimit: '0x5208',
  gasUsed: '0x0',
  transactions: [],
})

/**
 * Drain all pending microtasks and one macro-task turn. Used in WS
 * subscribe tests to wait for fire-and-forget async chains
 * (`readyPromise.then(tryOpenBlockSubscription)`) to settle before
 * asserting on side-effects.
 */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

interface FakeWsSubscribeHandlers {
  onData: (data: unknown) => void
  onError: (err: unknown) => void
}

interface FakeWsClientOptions {
  /**
   * Called for every `transport.subscribe` invocation (probe + live).
   * `params` is the subscription params array (e.g. `['newHeads']`).
   * Return `{ unsubscribe }` to succeed, or throw to simulate a
   * transport-level rejection.
   */
  onSubscribe?: (
    params: unknown[],
    handlers: FakeWsSubscribeHandlers,
  ) => { unsubscribe: () => void }
  /**
   * Block fixtures keyed by `eth_getBlockByNumber` tag. Supports
   * `'latest'` and hex block numbers.
   */
  blocks?: Record<string, BlockResult>
  /**
   * Tx fixtures keyed by hash for `eth_getTransactionByHash`. Used by
   * `newPendingTransactions` WS-path tests where the push notification
   * carries a hash and the source fetches the full tx.
   */
  txByHash?: Record<string, RawTx>
}

/**
 * Build a fake PublicClient whose transport has a working
 * `transport.subscribe` function — simulating a viem WebSocket
 * transport. Used by WS-path tests in `subscribeBlocks` and
 * `subscribeMempool`.
 *
 * The probe that `probeCapabilities` fires on construction resolves via
 * the same `onSubscribe` callback; it calls unsubscribe immediately, so
 * it doesn't interfere with the lazily-opened subscriptions.
 */
const makeFakeWsClient = (opts: FakeWsClientOptions = {}): PublicClient => {
  const blocks = opts.blocks ?? {}
  const txByHash = opts.txByHash ?? {}
  const onSubscribe = opts.onSubscribe

  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (!onSubscribe) return { unsubscribe: vi.fn() }
      return onSubscribe(arg.params, { onData: arg.onData, onError: arg.onError })
    },
  )

  return {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method, params }: RpcCall) => {
      if (method === 'eth_getBlockByNumber') {
        const tag = (params as [string])[0]
        return blocks[tag] ?? null
      }
      if (method === 'eth_getTransactionByHash') {
        const hash = (params as [string])[0]
        return txByHash[hash] ?? null
      }
      // Capability probe methods: return permissive stubs so the probe
      // doesn't throw and saturate onError before the test proper starts.
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
}

test('subscribeBlocks fires after pollOnce when a block is fetched', async () => {
  const block = sampleBlock('0x10')
  const { client } = fakeClient({
    responses: { eth_getBlockByNumber: () => block },
  })
  const source = createChainSource({ client })
  const cb = vi.fn()
  source.subscribeBlocks(cb)

  await source.pollOnce()

  expect(cb).toHaveBeenCalledTimes(1)
  expect(cb).toHaveBeenCalledWith(block)
})

test('subscribeMempool fires with a normalized snapshot', async () => {
  const block = sampleBlock('0x10')
  const txPool: TxPoolContent = {
    pending: { '0xABC': { '0x5': { hash: '0xdef' } } },
    queued: {},
  }
  const { client } = fakeClient({
    responses: {
      eth_getBlockByNumber: () => block,
      txpool_content: () => txPool,
    },
  })
  const source = createChainSource({ client })
  const cb = vi.fn()
  source.subscribeMempool(cb)

  await source.pollOnce()

  expect(cb).toHaveBeenCalledTimes(1)
  // The cb receives a NORMALIZED snapshot — lowercase address keys,
  // decimal nonce keys.
  expect(cb).toHaveBeenCalledWith({
    pending: { '0xabc': { '5': { hash: '0xdef' } } },
    queued: {},
  })
})

test('one upstream poll cycle fans out to multiple block subscribers', async () => {
  const block = sampleBlock('0x10')
  const { client, calls } = fakeClient({
    responses: { eth_getBlockByNumber: () => block },
  })
  const source = createChainSource({ client })
  const a = vi.fn()
  const b = vi.fn()
  const c = vi.fn()
  source.subscribeBlocks(a)
  source.subscribeBlocks(b)
  source.subscribeBlocks(c)

  await source.pollOnce()

  expect(a).toHaveBeenCalledWith(block)
  expect(b).toHaveBeenCalledWith(block)
  expect(c).toHaveBeenCalledWith(block)
  // Critically: only ONE upstream eth_getBlockByNumber call, fanned
  // out to all subscribers. This is the multi-subscriber-per-stream
  // guarantee.
  const blockCalls = calls.filter((c) => c.method === 'eth_getBlockByNumber')
  expect(blockCalls).toHaveLength(1)
})

test('unsubscribeBlocks stops further delivery', async () => {
  const block = sampleBlock('0x10')
  const { client } = fakeClient({
    responses: { eth_getBlockByNumber: () => block },
  })
  const source = createChainSource({ client })
  const cb = vi.fn()
  const unsub = source.subscribeBlocks(cb)

  await source.pollOnce()
  expect(cb).toHaveBeenCalledTimes(1)

  unsub()
  await source.pollOnce()
  expect(cb).toHaveBeenCalledTimes(1)
})

test('tick skips eth_getBlockByNumber when eth_blockNumber probe shows static head', async () => {
  const block = sampleBlock('0x10')
  const { client, calls } = fakeClient({
    responses: {
      eth_blockNumber: () => '0x10',
      eth_getBlockByNumber: () => block,
      txpool_content: () => ({ pending: {}, queued: {} }),
    },
  })
  const source = createChainSource({ client })

  await source.pollOnce()
  await source.pollOnce()

  // Two ticks; head static at 0x10. The eth_blockNumber probe runs on
  // every tick (2x), but eth_getBlockByNumber only runs on the first
  // (head was unknown then) — the second tick's probe matches the
  // last-seen number and the expensive full-block fetch is skipped.
  const probeCalls = calls.filter((c) => c.method === 'eth_blockNumber').length
  const blockCalls = calls.filter((c) => c.method === 'eth_getBlockByNumber').length
  expect(probeCalls).toBe(2)
  expect(blockCalls).toBe(1)
})

test('tick fetches eth_getBlockByNumber every cycle when head advances', async () => {
  const blockA = { ...sampleBlock('0x10'), hash: '0xaaa' }
  const blockB = { ...sampleBlock('0x11'), hash: '0xbbb' }
  let probeI = 0
  let blockI = 0
  const { client, calls } = fakeClient({
    responses: {
      eth_blockNumber: () => (probeI++ === 0 ? '0x10' : '0x11'),
      eth_getBlockByNumber: () => (blockI++ === 0 ? blockA : blockB),
      txpool_content: () => ({ pending: {}, queued: {} }),
    },
  })
  const source = createChainSource({ client })

  await source.pollOnce()
  await source.pollOnce()

  // Head advances each tick — both block fetches run.
  const blockCalls = calls.filter((c) => c.method === 'eth_getBlockByNumber').length
  expect(blockCalls).toBe(2)
})

test('tick fetches eth_getBlockByNumber when probe fails (defensive fallthrough)', async () => {
  const block = sampleBlock('0x10')
  const { client, calls } = fakeClient({
    responses: {
      eth_blockNumber: () => {
        throw new Error('probe gated')
      },
      eth_getBlockByNumber: () => block,
      txpool_content: () => ({ pending: {}, queued: {} }),
    },
  })
  const source = createChainSource({ client })

  await source.pollOnce()
  await source.pollOnce()

  // Probe fails on every tick — we'd rather pay one extra fetch than
  // block on a flaky upstream that can't even report eth_blockNumber.
  // Both ticks run the full block fetch.
  const blockCalls = calls.filter((c) => c.method === 'eth_getBlockByNumber').length
  expect(blockCalls).toBe(2)
})

test('tick still fetches mempool when head is static (txs change between blocks)', async () => {
  const block = sampleBlock('0x10')
  const { client, calls } = fakeClient({
    responses: {
      eth_blockNumber: () => '0x10',
      eth_getBlockByNumber: () => block,
      txpool_content: () => ({ pending: {}, queued: {} }),
    },
  })
  const source = createChainSource({ client })

  await source.pollOnce()
  await source.pollOnce()

  // Two mempool fetches even though the block fetch was skipped on
  // tick 2 — head-probe gating only covers the block fan-out. Mempool
  // fan-out runs every cycle because txs come and go between blocks.
  const txpoolCalls = calls.filter((c) => c.method === 'txpool_content').length
  expect(txpoolCalls).toBeGreaterThanOrEqual(2)
})

test('head-probe gate state resets on stop — restart re-fetches the same block', async () => {
  const block = sampleBlock('0x10')
  const { client, calls } = fakeClient({
    responses: {
      eth_blockNumber: () => '0x10',
      eth_getBlockByNumber: () => block,
      txpool_content: () => ({ pending: {}, queued: {} }),
    },
  })
  const source = createChainSource({ client })

  await source.pollOnce()
  source.stop()
  await source.pollOnce()

  // Stop clears lastSeenBlockNumber along with the dedup state, so
  // the post-restart probe doesn't think the head is "still" what it
  // was before. Both ticks run the full fetch.
  const blockCalls = calls.filter((c) => c.method === 'eth_getBlockByNumber').length
  expect(blockCalls).toBe(2)
})

test('subscribeBlocks dedups: same block.hash across two ticks emits once', async () => {
  const block = sampleBlock('0x10')
  const { client } = fakeClient({
    responses: { eth_getBlockByNumber: () => block },
  })
  const source = createChainSource({ client })
  const cb = vi.fn()
  source.subscribeBlocks(cb)

  await source.pollOnce()
  await source.pollOnce()

  // Same block hash on both ticks — emit only once. A consumer
  // (gas-oracle, tx-tracker) receives "new block observed" events, not
  // "we polled again" events.
  expect(cb).toHaveBeenCalledTimes(1)
  expect(cb).toHaveBeenCalledWith(block)
})

test('subscribeBlocks re-emits when block.hash changes', async () => {
  const blockA = { ...sampleBlock('0x10'), hash: '0xaaa' }
  const blockB = { ...sampleBlock('0x11'), hash: '0xbbb' }
  let i = 0
  const { client } = fakeClient({
    responses: {
      eth_getBlockByNumber: () => (i++ === 0 ? blockA : blockB),
    },
  })
  const source = createChainSource({ client })
  const cb = vi.fn()
  source.subscribeBlocks(cb)

  await source.pollOnce()
  await source.pollOnce()

  expect(cb).toHaveBeenCalledTimes(2)
  expect(cb).toHaveBeenNthCalledWith(1, blockA)
  expect(cb).toHaveBeenNthCalledWith(2, blockB)
})

test('subscribeBlocks re-emits on a same-height reorg (different hash)', async () => {
  const original = { ...sampleBlock('0x10'), hash: '0xorig' }
  const reorged  = { ...sampleBlock('0x10'), hash: '0xreorg' }
  let i = 0
  const { client } = fakeClient({
    responses: {
      eth_getBlockByNumber: () => (i++ === 0 ? original : reorged),
    },
  })
  const source = createChainSource({ client })
  const cb = vi.fn()
  source.subscribeBlocks(cb)

  await source.pollOnce()
  await source.pollOnce()

  // Same block.number, different block.hash — that's a reorg. Dedup
  // by number alone would silently swallow it. Hash-based dedup
  // surfaces it as a new observation.
  expect(cb).toHaveBeenCalledTimes(2)
  expect(cb).toHaveBeenNthCalledWith(1, original)
  expect(cb).toHaveBeenNthCalledWith(2, reorged)
})

test('subscribeMempool does NOT dedup — every successful snapshot fires', async () => {
  const block = sampleBlock('0x10')
  const txPool: TxPoolContent = {
    pending: { '0xABC': { '0x5': { hash: '0xdef' } } },
    queued: {},
  }
  const { client } = fakeClient({
    responses: {
      eth_getBlockByNumber: () => block,
      txpool_content: () => txPool,
    },
  })
  const source = createChainSource({ client })
  const cb = vi.fn()
  source.subscribeMempool(cb)

  await source.pollOnce()
  await source.pollOnce()

  // Mempool changes between blocks even when the head doesn't move
  // (txs come and go). Every successful txpool_content fans out — only
  // the block stream is deduped.
  expect(cb).toHaveBeenCalledTimes(2)
})

test('dedup state resets on stop — first tick after restart re-emits the same block', async () => {
  const block = sampleBlock('0x10')
  const { client } = fakeClient({
    responses: { eth_getBlockByNumber: () => block },
  })
  const source = createChainSource({ client })
  const cb = vi.fn()
  source.subscribeBlocks(cb)

  await source.pollOnce()
  expect(cb).toHaveBeenCalledTimes(1)

  source.stop()
  // After stop, lastEmitted state is cleared. The next pollOnce sees
  // the same hash but treats it as a fresh observation — a consumer
  // that paused and resumed should receive a current snapshot rather
  // than wait for the next chain block.
  await source.pollOnce()
  expect(cb).toHaveBeenCalledTimes(2)
})

test('mempool subscribers do not fire when txpool_content is gated', async () => {
  const block = sampleBlock('0x10')
  const { client } = fakeClient({
    responses: {
      eth_getBlockByNumber: () => block,
      txpool_content: () => {
        throw new Error('gated')
      },
    },
  })
  const source = createChainSource({ client })
  const blockCb = vi.fn()
  const mempoolCb = vi.fn()
  source.subscribeBlocks(blockCb)
  source.subscribeMempool(mempoolCb)

  await source.pollOnce()

  expect(blockCb).toHaveBeenCalledTimes(1)
  // Mempool sub does NOT fire on null. Don't emit a misleading
  // "mempool is empty" event when the underlying RPC failed.
  expect(mempoolCb).not.toHaveBeenCalled()
})

test('poll.mempool: false skips the txpool_content RPC during tick', async () => {
  const block = sampleBlock('0x10')
  const { client, calls } = fakeClient({
    responses: { eth_getBlockByNumber: () => block },
  })
  const source = createChainSource({ client, poll: { mempool: false } })
  // Wait for the eager capability probe to settle (it issues one
  // txpool_content call independently of the poll-toggle — capability
  // disclosure is separate from runtime fan-out).
  await source.ready()
  const probeCalls = calls.filter((c) => c.method === 'txpool_content').length

  source.subscribeMempool(vi.fn())
  await source.pollOnce()

  // The runtime tick added zero new txpool_content calls beyond the
  // probe — the toggle short-circuits the cycle's mempool branch.
  const totalCalls = calls.filter((c) => c.method === 'txpool_content').length
  expect(totalCalls).toBe(probeCalls)
})

test('getBlock fetches latest by default', async () => {
  const block = sampleBlock('0x42')
  const { client, calls } = fakeClient({
    responses: { eth_getBlockByNumber: () => block },
  })
  const source = createChainSource({ client })

  const result = await source.getBlock('latest')

  expect(result).toBe(block)
  expect(calls).toContainEqual({
    method: 'eth_getBlockByNumber',
    params: ['latest', true],
  })
})

test('getBlock encodes a bigint block tag as hex', async () => {
  const block = sampleBlock('0x3039')
  const { client, calls } = fakeClient({
    responses: { eth_getBlockByNumber: () => block },
  })
  const source = createChainSource({ client })

  await source.getBlock(12345n)

  expect(calls).toContainEqual({
    method: 'eth_getBlockByNumber',
    params: ['0x3039', true],
  })
})

test('getBlockByHash calls eth_getBlockByHash with the hash + full-tx flag', async () => {
  const block = sampleBlock('0x42')
  const { client, calls } = fakeClient({
    responses: { eth_getBlockByHash: () => block },
  })
  const source = createChainSource({ client })

  const result = await source.getBlockByHash('0xabc')

  expect(result).toBe(block)
  expect(calls).toContainEqual({
    method: 'eth_getBlockByHash',
    params: ['0xabc', true],
  })
})

test('getBlockByHash returns null when the upstream is missing the hash (deep reorg)', async () => {
  const { client } = fakeClient({
    responses: { eth_getBlockByHash: () => null },
  })
  const source = createChainSource({ client })

  const result = await source.getBlockByHash('0xgone')

  expect(result).toBeNull()
})

test('getFeeHistory passes blockCount + percentiles', async () => {
  const fixture: FeeHistoryResult = {
    baseFeePerGas: ['0x1'],
    gasUsedRatio: [],
    oldestBlock: '0x0',
  }
  const { client, calls } = fakeClient({
    responses: { eth_feeHistory: () => fixture },
  })
  const source = createChainSource({ client })

  const result = await source.getFeeHistory(5, [25, 75])

  expect(result).toBe(fixture)
  expect(calls).toContainEqual({
    method: 'eth_feeHistory',
    params: ['0x5', 'latest', [25, 75]],
  })
})

test('getMempoolSnapshot fetches fresh and returns the normalized form', async () => {
  const txPool: TxPoolContent = {
    pending: { '0xABC': { '0xa': { hash: '0xdef' } } },
    queued: {},
  }
  const { client } = fakeClient({
    responses: { txpool_content: () => txPool },
  })
  const source = createChainSource({ client })

  const snapshot = await source.getMempoolSnapshot()

  expect(snapshot).toEqual({
    pending: { '0xabc': { '10': { hash: '0xdef' } } },
    queued: {},
  })
})

test('getMempoolSnapshot returns null when txpool_content is gated', async () => {
  const { client } = fakeClient({
    responses: {
      txpool_content: () => {
        throw new Error('gated')
      },
    },
  })
  const source = createChainSource({ client })

  const snapshot = await source.getMempoolSnapshot()

  expect(snapshot).toBeNull()
})

test('getReceipt forwards the hash and returns the receipt', async () => {
  const receipt: TransactionReceipt = {
    transactionHash: '0xabc',
    blockHash: '0xblock',
    blockNumber: '0x10',
    status: '0x1',
  }
  const { client, calls } = fakeClient({
    responses: { eth_getTransactionReceipt: () => receipt },
  })
  const source = createChainSource({ client })

  const result = await source.getReceipt('0xabc')

  expect(result).toEqual(receipt)
  expect(calls).toContainEqual({
    method: 'eth_getTransactionReceipt',
    params: ['0xabc'],
  })
})

test('getTransaction forwards the hash and returns the tx', async () => {
  const tx: RawTx = { hash: '0xabc', from: '0x123', nonce: '0x5' }
  const { client, calls } = fakeClient({
    responses: { eth_getTransactionByHash: () => tx },
  })
  const source = createChainSource({ client })

  const result = await source.getTransaction('0xabc')

  expect(result).toBe(tx)
  expect(calls).toContainEqual({
    method: 'eth_getTransactionByHash',
    params: ['0xabc'],
  })
})

test('capabilities() returns probed values after the probe lands', async () => {
  const { client } = fakeClient({
    transport: { type: 'http' },
    responses: {
      txpool_content: () => ({ pending: {}, queued: {} }),
      eth_getTransactionReceipt: () => null,
    },
  })
  const source = createChainSource({ client })

  // Wait for the probe to land — the eager probe at construction is
  // fire-and-forget; one microtask cycle covers it for stub clients.
  await source.ready()

  const caps = source.capabilities()
  expect(caps.txpoolContent).toBe('available')
  expect(caps.receiptByHash).toBe('available')
  expect(caps.newHeads).toBe('unavailable')
  expect(caps.reprobeOnReconnect).toBe(false)
})

test('start is idempotent — calling twice does not double-fire ticks', async () => {
  const block = sampleBlock('0x10')
  const { client, calls } = fakeClient({
    responses: { eth_getBlockByNumber: () => block },
  })
  const source = createChainSource({ client, pollIntervalMs: 1_000_000 })

  vi.useFakeTimers()
  try {
    source.start()
    source.start()
    // The first tick is fire-and-forget at start — wait for it.
    await vi.advanceTimersByTimeAsync(0)

    // Filter to tick-driven calls only: tick uses `fullTransactions: true`,
    // whereas the v0.16+ adaptive scheduler's block-time estimation uses
    // `fullTransactions: false` for both the `latest` and lookback fetches.
    const tickCalls = calls.filter(
      (c) =>
        c.method === 'eth_getBlockByNumber' &&
        Array.isArray(c.params) &&
        c.params[1] === true,
    )
    expect(tickCalls).toHaveLength(1)

    source.stop()
  } finally {
    vi.useRealTimers()
  }
})

test('stop halts the poll loop — subscribers stop receiving', async () => {
  const block = sampleBlock('0x10')
  const { client } = fakeClient({
    responses: { eth_getBlockByNumber: () => block },
  })
  const source = createChainSource({ client, pollIntervalMs: 100 })
  const cb = vi.fn()
  source.subscribeBlocks(cb)

  vi.useFakeTimers()
  try {
    source.start()
    await vi.advanceTimersByTimeAsync(0) // first tick
    expect(cb).toHaveBeenCalledTimes(1)

    source.stop()

    await vi.advanceTimersByTimeAsync(500) // would have fired more ticks
    expect(cb).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})

test('stop is idempotent — second call is a no-op', async () => {
  const { client } = fakeClient()
  const source = createChainSource({ client })
  source.start()
  expect(() => {
    source.stop()
    source.stop()
  }).not.toThrow()
})

test('onError fires for sub-RPC failures during poll cycle', async () => {
  const block = sampleBlock('0x10')
  const onError = vi.fn<(method: string, err: unknown) => void>()
  const { client } = fakeClient({
    responses: {
      eth_getBlockByNumber: () => block,
      txpool_content: () => {
        throw new Error('gated')
      },
    },
  })
  const source = createChainSource({ client, onError })

  await source.pollOnce()

  expect(
    onError.mock.calls.some(([method]) => method === 'txpool_content'),
  ).toBe(true)
})

test('the interval callback fires additional ticks after start', async () => {
  // Pin the setInterval-callback path: advance time past pollIntervalMs
  // and verify a second tick ran. The first tick is fired
  // immediately at start; subsequent ticks come from the interval.
  let counter = 0
  const { client, calls } = fakeClient({
    responses: {
      eth_getBlockByNumber: () => {
        counter += 1
        return sampleBlock('0x' + counter.toString(16))
      },
    },
  })
  const source = createChainSource({ client, pollIntervalMs: 100 })
  vi.useFakeTimers()
  try {
    source.start()
    await vi.advanceTimersByTimeAsync(0) // immediate first tick
    const afterFirst = calls.filter((c) => c.method === 'eth_getBlockByNumber').length
    await vi.advanceTimersByTimeAsync(150) // crosses interval boundary
    const afterSecond = calls.filter((c) => c.method === 'eth_getBlockByNumber').length
    expect(afterSecond).toBeGreaterThan(afterFirst)
    source.stop()
  } finally {
    vi.useRealTimers()
  }
})

test('subscribeBlocks — WS path emits via subscribe when newHeads === subscription', async () => {
  // Tracks the live subscription's onData — set twice (probe + live) but
  // after await source.ready() + start() + flush() the live subscription's
  // handler is the current value.
  let onDataHandler: ((data: { number: string }) => void) | null = null
  // The WS onData handler fetches the full block at 'latest'. The poll tick
  // also fetches 'latest'. We use a stateful counter to ensure the tick's
  // block fetch returns null (preventing lastEmittedBlockHash from being set
  // early), while the onData fetch returns the real block — this exercises
  // the full WS emit path including lines 240-247 in source.ts.
  let blockFetchCount = 0
  const blockFixture: BlockResult = {
    number: '0x10',
    hash: '0xblockhash10',
    transactions: [],
    parentHash: '0x0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
  }
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] === 'newHeads') onDataHandler = arg.onData as (data: { number: string }) => void
      return { unsubscribe: vi.fn() }
    },
  )
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      if (method === 'eth_getBlockByNumber') {
        // First call is from the poll tick — return null so the dedup state
        // stays unset. Subsequent calls (from onData) return the real block.
        blockFetchCount++
        return blockFetchCount === 1 ? null : blockFixture
      }
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({ client })
  await source.ready()

  const received: BlockResult[] = []
  source.subscribeBlocks((b) => received.push(b))
  source.start()

  // Wait for the lazy block subscription to land (readyPromise.then chain).
  await flush()
  expect(onDataHandler).not.toBeNull()

  // Push a head event via the WS handler; onData fetches 'latest' + emits.
  // At this point lastEmittedBlockHash is still undefined (poll got null),
  // so the dedup check passes and blockSubs.emit fires — covering lines 240-247.
  onDataHandler!({ number: '0x10' })
  await flush()

  expect(received).toHaveLength(1)
  expect(received[0].hash).toBe('0xblockhash10')
  source.stop()
})

test('subscribeBlocks — WS subscribe failure falls back to poll without error', async () => {
  const onError = vi.fn()
  const client = makeFakeWsClient({
    onSubscribe: () => {
      throw new Error('subscribe rejected')
    },
    blocks: {
      latest: {
        number: '0x20',
        hash: '0xblockhash20',
        transactions: [],
        parentHash: '0x0',
        timestamp: '0x0',
        baseFeePerGas: '0x0',
        gasLimit: '0x0',
        gasUsed: '0x0',
      },
    },
  })
  const source = createChainSource({ client, onError, pollIntervalMs: 5 })
  await source.ready()

  const received: BlockResult[] = []
  source.subscribeBlocks((b) => received.push(b))
  source.start()
  await flush()

  // Should NOT throw; should have logged via onError; should still be polling.
  expect(onError).toHaveBeenCalledWith('eth_subscribe', expect.any(Error))
  // Allow at least one tick.
  await new Promise((r) => setTimeout(r, 12))
  expect(received.length).toBeGreaterThan(0)
  source.stop()
})

test('subscribeBlocks — lazy subscribe throw after probe success downgrades to poll-only', async () => {
  // Probe succeeds (first subscribe call returns normally). The lazy
  // subscription attempt (second subscribe call) throws — this exercises
  // the catch block in tryOpenBlockSubscription (lines 253-255 in source.ts).
  let subscribeCallCount = 0
  const onError = vi.fn()
  const blockFixture: BlockResult = {
    number: '0x20',
    hash: '0xws-lazy-fail',
    transactions: [],
    parentHash: '0x0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
  }
  const subscribe = vi.fn(async (): Promise<{ unsubscribe: () => void }> => {
    subscribeCallCount++
    if (subscribeCallCount === 1) {
      // Probe call — succeed and immediately return so unsubscribe is callable.
      return { unsubscribe: vi.fn() }
    }
    // Lazy block subscription call — throw to exercise the catch path.
    throw new Error('lazy subscribe rejected')
  })
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      if (method === 'eth_getBlockByNumber') return blockFixture
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({ client, onError, pollIntervalMs: 5 })
  await source.ready()

  // Probe succeeded → capability is 'subscription'.
  expect(source.capabilities().newHeads).toBe('subscription')

  const received: BlockResult[] = []
  source.subscribeBlocks((b) => received.push(b))
  source.start()
  await flush()

  // Lazy subscribe threw → onError fired + capability downgraded to poll-only.
  expect(onError).toHaveBeenCalledWith('eth_subscribe.newHeads', expect.any(Error))
  expect(source.capabilities().newHeads).toBe('poll-only')
  // Poll loop still delivers blocks.
  await new Promise((r) => setTimeout(r, 12))
  expect(received.length).toBeGreaterThan(0)
  source.stop()
})

test('stop — unsubscribe throw routes to onError', async () => {
  // blockSubscriptionHandle.unsubscribe() throwing exercises the catch block
  // in stop(). The error should be routed to onError and stop should complete
  // without propagating the throw.
  //
  // subscribe is called three times: once by the capability probe
  // (unsubscribe must NOT throw — probe unsubscribes immediately), once by
  // tryOpenBlockSubscription (unsubscribe DOES throw when stop() is called),
  // and once by tryOpenMempoolSubscription (unsubscribe must NOT throw — we
  // only want the block sub to exercise the error path here).
  const onError = vi.fn()
  let capturedOnData: ((data: unknown) => void) | null = null
  let newHeadsCallCount = 0
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] === 'newHeads') {
        newHeadsCallCount++
        if (newHeadsCallCount === 1) {
          // Probe call — unsubscribes immediately; must not throw.
          return { unsubscribe: vi.fn() }
        }
        // Live block subscription — unsubscribe throws when stop() calls it.
        capturedOnData = arg.onData
        return {
          unsubscribe: vi.fn(() => {
            throw new Error('unsubscribe failed')
          }),
        }
      }
      // newPendingTransactions live subscription — unsubscribe must not throw.
      return { unsubscribe: vi.fn() }
    },
  )
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({ client, onError })
  await source.ready()
  source.start()
  await flush()

  // Live subscription is open (capturedOnData was set by the lazy subscribe).
  expect(capturedOnData).not.toBeNull()

  // stop() calls unsubscribe(), which throws — should route to onError.
  expect(() => source.stop()).not.toThrow()
  expect(onError).toHaveBeenCalledWith('eth_unsubscribe', expect.any(Error))
})

test('subscribeBlocks — WS stream-level onError routes to options.onError', async () => {
  // Exercises the onError callback passed to transport.subscribe for the live
  // block subscription. This fires when the WS transport itself encounters a
  // stream-level error AFTER the subscription is open.
  let capturedStreamOnError: ((err: unknown) => void) | null = null
  let newHeadsCallCount = 0
  const onError = vi.fn()
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] === 'newHeads') {
        newHeadsCallCount++
        if (newHeadsCallCount === 1) {
          // Probe call — succeed normally.
          return { unsubscribe: vi.fn() }
        }
        // Live block subscription — capture the stream-level onError.
        capturedStreamOnError = arg.onError
        return { unsubscribe: vi.fn() }
      }
      // newPendingTransactions — return no-op subscription.
      return { unsubscribe: vi.fn() }
    },
  )
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({ client, onError })
  await source.ready()
  source.start()
  await flush()

  expect(capturedStreamOnError).not.toBeNull()

  // Simulate the WS transport firing a stream-level error.
  capturedStreamOnError!(new Error('stream error'))

  expect(onError).toHaveBeenCalledWith('eth_subscribe.newHeads', expect.any(Error))
  source.stop()
})

test('subscribeBlocks — WS onData with unparseable block number still emits', async () => {
  // Exercises the try/catch for BigInt(block.number) inside onData (lines
  // 241-246 in source.ts). A block with a non-hex number field should still
  // emit the block — the catch leaves lastSeenBlockNumber untouched rather
  // than propagating.
  let newHeadsCallCount = 0
  let capturedOnData: ((data: unknown) => void) | null = null
  const badBlock: BlockResult = {
    number: 'not-a-hex-number',
    hash: '0xbadnumblock',
    transactions: [],
    parentHash: '0x0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
  }
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] === 'newHeads') {
        newHeadsCallCount++
        if (newHeadsCallCount === 1) return { unsubscribe: vi.fn() }
        capturedOnData = arg.onData
        return { unsubscribe: vi.fn() }
      }
      // newPendingTransactions — return no-op subscription.
      return { unsubscribe: vi.fn() }
    },
  )
  let blockFetchesForOnData = 0
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      if (method === 'eth_getBlockByNumber') {
        blockFetchesForOnData++
        // First fetch is from the poll tick — return null so
        // lastEmittedBlockHash is unset when onData fires.
        return blockFetchesForOnData === 1 ? null : badBlock
      }
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({ client })
  await source.ready()

  const received: BlockResult[] = []
  source.subscribeBlocks((b) => received.push(b))
  source.start()
  await flush()

  expect(capturedOnData).not.toBeNull()
  // onData fires — fetchBlock returns badBlock whose number can't be parsed
  // by BigInt. The catch swallows the error and blockSubs.emit still fires.
  capturedOnData!(null)
  await flush()

  expect(received).toHaveLength(1)
  expect(received[0].hash).toBe('0xbadnumblock')
  source.stop()
})

test('subscribeBlocks — WS onData when fetchBlock returns null does not emit', async () => {
  // Exercises the `if (!block) return` early-exit in handleHeadNotification.
  // fetchBlock returns null (e.g. upstream error) — the subscriber must not
  // receive an event.
  let newHeadsCallCount = 0
  let capturedOnData: ((data: unknown) => void) | null = null
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] === 'newHeads') {
        newHeadsCallCount++
        if (newHeadsCallCount === 1) return { unsubscribe: vi.fn() }
        capturedOnData = arg.onData
        return { unsubscribe: vi.fn() }
      }
      return { unsubscribe: vi.fn() }
    },
  )
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      // All eth_getBlockByNumber calls return null — including the onData fetch.
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({ client })
  await source.ready()

  const received: BlockResult[] = []
  source.subscribeBlocks((b) => received.push(b))
  source.start()
  await flush()

  expect(capturedOnData).not.toBeNull()
  capturedOnData!(null)
  await flush()

  // fetchBlock returned null — no emission.
  expect(received).toHaveLength(0)
  source.stop()
})

test('subscribeBlocks — WS onData deduplication prevents double-emit for same hash', async () => {
  // Exercises the false branch of `if (block.hash !== lastEmittedBlockHash)`
  // in handleHeadNotification — when the block hash matches what was already
  // emitted, blockSubs.emit must NOT fire again.
  let newHeadsCallCount = 0
  let capturedOnData: ((data: unknown) => void) | null = null
  const block: BlockResult = {
    number: '0x30',
    hash: '0xdupehash',
    transactions: [],
    parentHash: '0x0',
    timestamp: '0x0',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
  }
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] === 'newHeads') {
        newHeadsCallCount++
        if (newHeadsCallCount === 1) return { unsubscribe: vi.fn() }
        capturedOnData = arg.onData
        return { unsubscribe: vi.fn() }
      }
      return { unsubscribe: vi.fn() }
    },
  )
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      if (method === 'eth_getBlockByNumber') return block
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({ client })
  await source.ready()

  const received: BlockResult[] = []
  source.subscribeBlocks((b) => received.push(b))
  source.start()
  // Wait for the poll tick to emit the first block and set lastEmittedBlockHash.
  await flush()

  expect(capturedOnData).not.toBeNull()
  // First onData call — block hash matches lastEmittedBlockHash set by poll.
  capturedOnData!(null)
  await flush()
  // Second onData call — same hash again.
  capturedOnData!(null)
  await flush()

  // Poll emitted one. WS onData calls are both deduped (same hash).
  // Exactly one emission total.
  expect(received).toHaveLength(1)
  source.stop()
})

test('subscribeMempool — WS path emits hash-only normalized snapshot', async () => {
  let onDataHandler: ((data: unknown) => void) | null = null
  const client = makeFakeWsClient({
    onSubscribe: (params, handlers) => {
      if (params[0] === 'newPendingTransactions') onDataHandler = handlers.onData
      return { unsubscribe: vi.fn() }
    },
    txByHash: {
      '0xpending1': { hash: '0xpending1', from: '0xs1', nonce: '0x1' },
    },
  })
  const source = createChainSource({ client })
  await source.ready()

  const received: NormalizedMempool[] = []
  source.subscribeMempool((s) => received.push(s))
  source.start()
  await flush()
  expect(onDataHandler).not.toBeNull()

  // Push a hash via WS — source fetches the full tx and emits a
  // single-tx NormalizedMempool snapshot. The poll cycle may also emit
  // an empty snapshot concurrently; we find the WS-pushed one by content.
  onDataHandler!('0xpending1')
  await flush()

  const wsSnapshot = received.find((s) => s.pending['0xs1'] !== undefined)
  expect(wsSnapshot).toBeDefined()
  expect(wsSnapshot!.pending['0xs1']?.['1']?.hash).toBe('0xpending1')
  source.stop()
})

test('subscribeBlocks — WS stream onError without options.onError does not throw', async () => {
  // Exercises the false branch of `options.onError?.()` in the stream-level
  // onError callback — when no onError handler is provided, the optional chain
  // short-circuits without throwing.
  let newHeadsCallCount = 0
  let capturedStreamOnError: ((err: unknown) => void) | null = null
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] !== 'newHeads') {
        // mempool sub — no-op; not the path under test
        return { unsubscribe: vi.fn() }
      }
      newHeadsCallCount++
      if (newHeadsCallCount === 1) {
        // first newHeads call is the probe
        return { unsubscribe: vi.fn() }
      }
      // second newHeads call is the live block subscription
      capturedStreamOnError = arg.onError
      return { unsubscribe: vi.fn() }
    },
  )
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  // No onError provided — tests the optional-chain false branch.
  const source = createChainSource({ client })
  await source.ready()
  source.start()
  await flush()

  expect(capturedStreamOnError).not.toBeNull()
  expect(() => capturedStreamOnError!(new Error('stream error'))).not.toThrow()
  source.stop()
})

// ─── subscribeMempool WS path — coverage tests ───────────────────────────────

test('subscribeMempool — WS onData with object payload extracts .hash', async () => {
  // Exercises the `(data as { hash?: string }).hash` fallback branch in the
  // mempool onData handler — some providers send a full-tx-like object rather
  // than a bare hash string.
  let onDataHandler: ((data: unknown) => void) | null = null
  const client = makeFakeWsClient({
    onSubscribe: (params, handlers) => {
      if (params[0] === 'newPendingTransactions') onDataHandler = handlers.onData
      return { unsubscribe: vi.fn() }
    },
    txByHash: {
      '0xobj1': { hash: '0xobj1', from: '0xsender2', nonce: '0x2' },
    },
  })
  const source = createChainSource({ client })
  await source.ready()

  const received: NormalizedMempool[] = []
  source.subscribeMempool((s) => received.push(s))
  source.start()
  await flush()
  expect(onDataHandler).not.toBeNull()

  // Push an object payload (not a bare string) — the handler extracts .hash.
  onDataHandler!({ hash: '0xobj1' })
  await flush()

  const wsSnapshot = received.find((s) => s.pending['0xsender2'] !== undefined)
  expect(wsSnapshot).toBeDefined()
  expect(wsSnapshot!.pending['0xsender2']?.['2']?.hash).toBe('0xobj1')
  source.stop()
})

test('subscribeMempool — WS onData with null/no hash is a no-op', async () => {
  // Exercises the `if (!hash) return` early-exit in the mempool onData handler.
  let onDataHandler: ((data: unknown) => void) | null = null
  const client = makeFakeWsClient({
    onSubscribe: (params, handlers) => {
      if (params[0] === 'newPendingTransactions') onDataHandler = handlers.onData
      return { unsubscribe: vi.fn() }
    },
  })
  const source = createChainSource({ client })
  await source.ready()

  const received: NormalizedMempool[] = []
  source.subscribeMempool((s) => received.push(s))
  source.start()
  await flush()
  expect(onDataHandler).not.toBeNull()

  // Push an object with no hash field — must not emit or throw.
  onDataHandler!({})
  await flush()

  const wsSnapshots = received.filter((s) => Object.keys(s.pending).length > 0)
  expect(wsSnapshots).toHaveLength(0)
  source.stop()
})

test('subscribeMempool — WS onData when getTransaction returns null does not emit', async () => {
  // Exercises the `if (!tx?.from || !tx.nonce) return` guard in
  // handleMempoolNotification — when the hash lookup returns null, no
  // mempoolSubs emission occurs.
  let onDataHandler: ((data: unknown) => void) | null = null
  const client = makeFakeWsClient({
    onSubscribe: (params, handlers) => {
      if (params[0] === 'newPendingTransactions') onDataHandler = handlers.onData
      return { unsubscribe: vi.fn() }
    },
    // No txByHash entry — getTransaction will return null.
  })
  const source = createChainSource({ client })
  await source.ready()

  const received: NormalizedMempool[] = []
  source.subscribeMempool((s) => received.push(s))
  source.start()
  await flush()
  expect(onDataHandler).not.toBeNull()

  // Push a hash that has no matching tx — getTransaction returns null.
  onDataHandler!('0xunknown')
  await flush()

  const wsSnapshots = received.filter((s) => Object.keys(s.pending).length > 0)
  expect(wsSnapshots).toHaveLength(0)
  source.stop()
})

test('subscribeMempool — WS onData with unparseable nonce still emits', async () => {
  // Exercises the catch block in handleMempoolNotification: BigInt(tx.nonce)
  // throws for a non-hex nonce — the raw nonce string is used as the key and
  // the snapshot is still emitted.
  let onDataHandler: ((data: unknown) => void) | null = null
  const client = makeFakeWsClient({
    onSubscribe: (params, handlers) => {
      if (params[0] === 'newPendingTransactions') onDataHandler = handlers.onData
      return { unsubscribe: vi.fn() }
    },
    txByHash: {
      '0xbadnonce': { hash: '0xbadnonce', from: '0xsender3', nonce: 'not-a-nonce' },
    },
  })
  const source = createChainSource({ client })
  await source.ready()

  const received: NormalizedMempool[] = []
  source.subscribeMempool((s) => received.push(s))
  source.start()
  await flush()
  expect(onDataHandler).not.toBeNull()

  // Push a hash whose tx has an unparseable nonce — the catch falls back to
  // the raw nonce string as the slot key.
  onDataHandler!('0xbadnonce')
  await flush()

  const wsSnapshot = received.find((s) => s.pending['0xsender3'] !== undefined)
  expect(wsSnapshot).toBeDefined()
  // Raw nonce used as key since BigInt('not-a-nonce') throws.
  expect(wsSnapshot!.pending['0xsender3']?.['not-a-nonce']?.hash).toBe('0xbadnonce')
  source.stop()
})

test('subscribeMempool — WS subscribe failure downgrades to poll-only', async () => {
  // Exercises the catch block in tryOpenMempoolSubscription — the live
  // subscribe call throws. Capability should downgrade to 'poll-only' when
  // txpoolContent is 'available'. Note: probeCapabilities only probes
  // 'newHeads' — there is no probe call for 'newPendingTransactions'; the
  // first call for that subscription type IS the live subscription attempt.
  const onError = vi.fn()
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] === 'newHeads') {
        // Probe call — succeed.
        return { unsubscribe: vi.fn() }
      }
      // newPendingTransactions live subscribe — throw to trigger downgrade.
      throw new Error('mempool subscribe rejected')
    },
  )
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({ client, onError })
  await source.ready()

  // Probe succeeded — newPendingTransactions should be 'subscription'.
  expect(source.capabilities().newPendingTransactions).toBe('subscription')

  source.start()
  await flush()

  // Subscribe threw → onError fired + capability downgraded.
  expect(onError).toHaveBeenCalledWith(
    'eth_subscribe.newPendingTransactions',
    expect.any(Error),
  )
  expect(source.capabilities().newPendingTransactions).toBe('poll-only')
  source.stop()
})

test('subscribeMempool — WS subscribe failure downgrades to unavailable when txpool gated', async () => {
  // Exercises the alternate downgrade path in tryOpenMempoolSubscription:
  // when txpoolContent is 'gated', a subscribe failure downgrades to
  // 'unavailable' rather than 'poll-only'. probeCapabilities only probes
  // 'newHeads' — the first 'newPendingTransactions' call is the live attempt.
  const onError = vi.fn()
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] === 'newHeads') return { unsubscribe: vi.fn() }
      // newPendingTransactions live subscribe — throw to trigger downgrade.
      throw new Error('mempool subscribe rejected')
    },
  )
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      // txpool_content throws — capability is 'gated'.
      if (method === 'txpool_content') throw new Error('gated')
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({ client, onError })
  await source.ready()

  expect(source.capabilities().newPendingTransactions).toBe('subscription')

  source.start()
  await flush()

  expect(source.capabilities().newPendingTransactions).toBe('unavailable')
  source.stop()
})

test('subscribeMempool — poll.mempool false skips WS subscription entirely', async () => {
  // Exercises the `if (!fetchMempool) return` guard in
  // tryOpenMempoolSubscription — when mempool is disabled in poll options,
  // the WS subscribe call for newPendingTransactions must not be opened.
  let newPendingTxSubscribed = false
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] === 'newPendingTransactions') newPendingTxSubscribed = true
      return { unsubscribe: vi.fn() }
    },
  )
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({ client, poll: { mempool: false } })
  await source.ready()
  source.start()
  await flush()

  expect(newPendingTxSubscribed).toBe(false)
  source.stop()
})

test('stop — mempool unsubscribe throw routes to onError', async () => {
  // Exercises the catch block for mempoolSubscriptionHandle.unsubscribe()
  // throwing in stop(). The error should be routed to onError and stop
  // should complete without propagating the throw.
  // probeCapabilities only calls subscribe for 'newHeads', so the first
  // 'newPendingTransactions' subscribe call IS the live subscription.
  const onError = vi.fn()
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] === 'newHeads') return { unsubscribe: vi.fn() }
      // newPendingTransactions live subscription — unsubscribe throws on stop().
      return {
        unsubscribe: vi.fn(() => {
          throw new Error('mempool unsubscribe failed')
        }),
      }
    },
  )
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({ client, onError })
  await source.ready()
  source.start()
  await flush()

  // stop() calls mempoolSubscriptionHandle.unsubscribe() → throws → onError.
  expect(() => source.stop()).not.toThrow()
  expect(onError).toHaveBeenCalledWith('eth_unsubscribe', expect.any(Error))
})

test('subscribeMempool — WS stream-level onError routes to options.onError', async () => {
  // Exercises the onError callback passed to transport.subscribe for the live
  // mempool subscription — fires when the WS transport encounters a stream-level
  // error AFTER the subscription is open. probeCapabilities only calls
  // subscribe for 'newHeads', so the first 'newPendingTransactions' call IS
  // the live subscription.
  let capturedMempoolStreamError: ((err: unknown) => void) | null = null
  const onError = vi.fn()
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] === 'newHeads') return { unsubscribe: vi.fn() }
      // Live mempool subscription — capture the stream-level onError.
      capturedMempoolStreamError = arg.onError
      return { unsubscribe: vi.fn() }
    },
  )
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method }: RpcCall) => {
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({ client, onError })
  await source.ready()
  source.start()
  await flush()

  expect(capturedMempoolStreamError).not.toBeNull()

  // Simulate the WS transport firing a stream-level error on the mempool sub.
  capturedMempoolStreamError!(new Error('mempool stream error'))

  expect(onError).toHaveBeenCalledWith(
    'eth_subscribe.newPendingTransactions',
    expect.any(Error),
  )
  source.stop()
})

// ---------- v0.16 adaptive scheduler + logger tests ----------

const blockWithTs = (number: string, hash: string, ts: string): BlockResult => ({
  number,
  hash,
  parentHash: '0xparent',
  timestamp: ts,
  baseFeePerGas: '0x7',
  gasLimit: '0x5208',
  gasUsed: '0x0',
  transactions: [],
})

test('adaptive scheduler — estimateBlockTimeMs computed at start uses latest + lookback', async () => {
  // Block 100 at timestamp 1000s; block 100-256 at timestamp 1000 - 256*10s
  // → 10s per block expected.
  const latest = blockWithTs('0x100', '0xtip', '0x3e8') // 1000s
  // 0x100 - 0x100 = 0; if we sample 256 back from height 256 we'd get
  // height 0 — clamped. Make latest large enough: use 0x200 (512).
  const latestHi = blockWithTs('0x200', '0xtip', '0x4e20') // 20000s
  const old = blockWithTs(
    '0x100', // 256 back from 512
    '0xold',
    '0x4d8c', // 19852s = 20000s - 256*10s + (a couple seconds slop)
  )
  const requests: RpcCall[] = []
  const client = {
    transport: { type: 'http' },
    request: vi.fn(async (req: RpcCall) => {
      requests.push(req)
      if (req.method === 'eth_blockNumber') return '0x200'
      if (req.method === 'eth_getBlockByNumber') {
        const [tag, full] = req.params as [string, boolean]
        if (tag === 'latest') return full === true ? latestHi : latestHi
        if (tag === '0x100') return old
        return latest
      }
      return null
    }),
  } as unknown as PublicClient
  const logged: Array<[string, string, unknown]> = []
  const source = createChainSource({
    client,
    pollIntervalMs: 1_000_000,
    logger: (level, msg, meta) => logged.push([level, msg, meta]),
  })

  source.start()
  // Microtask drain to let estimateBlockTimeMs resolve.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))

  const estimateLog = logged.find(([, msg]) => msg === 'block time estimated')
  expect(estimateLog).toBeDefined()
  if (estimateLog) {
    const meta = estimateLog[2] as { estimatedBlockTimeMs: number }
    // (20000 - 19852) seconds / 256 blocks = 0.578s/block * 1000 = ~578ms.
    expect(meta.estimatedBlockTimeMs).toBeGreaterThan(0)
  }

  source.stop()
})

test('adaptive scheduler — estimateBlockTimeMs failure logs warning and falls back to pollIntervalMs', async () => {
  // RPC fails the historical lookup; estimation returns null; scheduler
  // should fall back to pollIntervalMs without crashing.
  const client = {
    transport: { type: 'http' },
    request: vi.fn(async (req: RpcCall) => {
      if (req.method === 'eth_blockNumber') return '0x10'
      if (req.method === 'eth_getBlockByNumber') {
        // Return latest fine, fail the lookback
        const [tag] = req.params as [string]
        if (tag === 'latest') {
          return blockWithTs('0x10', '0xtip', '0x100')
        }
        return null
      }
      return null
    }),
  } as unknown as PublicClient
  const logged: Array<[string, string]> = []
  const source = createChainSource({
    client,
    pollIntervalMs: 1_000_000,
    logger: (level, msg) => logged.push([level, msg]),
  })

  source.start()
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))

  const warnLog = logged.find(
    ([level, msg]) =>
      level === 'warn' && msg.includes('block time estimation failed'),
  )
  expect(warnLog).toBeDefined()
  source.stop()
})

test('adaptive scheduler — retry backoff applies when head does not move', async () => {
  // Stub returns the same head forever. After the first tick (head
  // moved from undefined), subsequent ticks back off: 2s, 4s, 8s.
  let blockCount = 0
  const block = blockWithTs('0x10', '0xstatic', '0x1')
  const client = {
    transport: { type: 'http' },
    request: vi.fn(async (req: RpcCall) => {
      if (req.method === 'eth_blockNumber') return '0x10'
      if (req.method === 'eth_getBlockByNumber') {
        const [, full] = req.params as [string, boolean]
        if (full === true) blockCount += 1
        return block
      }
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({
    client,
    pollIntervalMs: 100, // would-be cadence in dumb mode
    adaptivePolling: { retryInitialMs: 2_000, retryMaxMs: 30_000 },
  })

  vi.useFakeTimers()
  try {
    source.start()
    await vi.advanceTimersByTimeAsync(0)
    // After tick 1, head moved (first observation); next scheduled at
    // pollIntervalMs=100ms (since estimation hasn't resolved yet — sync
    // setup).
    await vi.advanceTimersByTimeAsync(100)
    // Tick 2 — head didn't move, schedule next at 2000ms (retryInitialMs).
    await vi.advanceTimersByTimeAsync(200)
    // Within 200ms after tick 2, no more ticks should have fired
    // (backoff is 2000ms). blockCount stays at 1 (only the first tick's
    // full-block fetch — head probe gate skipped tick 2).
    expect(blockCount).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    // Now tick 3 has fired (at 100 + 2000 = 2100ms). Head still didn't
    // move; full-block fetch was skipped again by head-probe-gate.
    expect(blockCount).toBe(1)
    source.stop()
  } finally {
    vi.useRealTimers()
  }
})

test('adaptive scheduler — enabled: false reverts to legacy setInterval behavior', async () => {
  // With adaptive disabled, every tick fires at pollIntervalMs regardless
  // of whether the head moved.
  let blockProbeCount = 0
  const block = blockWithTs('0x10', '0xstatic', '0x1')
  const client = {
    transport: { type: 'http' },
    request: vi.fn(async (req: RpcCall) => {
      if (req.method === 'eth_blockNumber') {
        blockProbeCount += 1
        return '0x10'
      }
      if (req.method === 'eth_getBlockByNumber') return block
      return null
    }),
  } as unknown as PublicClient
  const source = createChainSource({
    client,
    pollIntervalMs: 100,
    adaptivePolling: { enabled: false },
  })

  vi.useFakeTimers()
  try {
    source.start()
    await vi.advanceTimersByTimeAsync(0)
    // Probe ran on tick 1 (immediate at start) — count = 1.
    expect(blockProbeCount).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    // setInterval at 100ms fires tick 2 — count = 2.
    expect(blockProbeCount).toBe(2)
    await vi.advanceTimersByTimeAsync(100)
    // tick 3 — count = 3. Dumb interval keeps firing regardless of head.
    expect(blockProbeCount).toBe(3)
    source.stop()
  } finally {
    vi.useRealTimers()
  }
})

test('logger — capability probe completion logged at info level', async () => {
  const logged: Array<[string, string]> = []
  const client = {
    transport: { type: 'http' },
    request: vi.fn(async () => null),
  } as unknown as PublicClient
  const source = createChainSource({
    client,
    pollIntervalMs: 1_000_000,
    logger: (level, msg) => logged.push([level, msg]),
  })
  source.start()
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))

  const probeLog = logged.find(
    ([level, msg]) => level === 'info' && msg === 'capability probe complete',
  )
  expect(probeLog).toBeDefined()
  source.stop()
})

test('logger — start() logs info with adaptive flag', async () => {
  const logged: Array<[string, string, unknown]> = []
  const client = {
    transport: { type: 'http' },
    request: vi.fn(async () => null),
  } as unknown as PublicClient
  const source = createChainSource({
    client,
    pollIntervalMs: 5_000,
    logger: (level, msg, meta) => logged.push([level, msg, meta]),
  })
  source.start()
  await new Promise((r) => setTimeout(r, 0))

  const startLog = logged.find(([, msg]) => msg === 'chain-source started')
  expect(startLog).toBeDefined()
  if (startLog) {
    const meta = startLog[2] as { pollIntervalMs: number; adaptiveEnabled: boolean }
    expect(meta.pollIntervalMs).toBe(5_000)
    expect(meta.adaptiveEnabled).toBe(true)
  }
  source.stop()
})

test('logger — missing logger does not crash the source', async () => {
  // No logger configured; source should run normally.
  const client = {
    transport: { type: 'http' },
    request: vi.fn(async () => null),
  } as unknown as PublicClient
  const source = createChainSource({ client, pollIntervalMs: 1_000_000 })
  expect(() => source.start()).not.toThrow()
  await new Promise((r) => setTimeout(r, 0))
  source.stop()
})

test('subscribeBlocks — WS onData with a new hash emits the block (handleHeadNotification fresh path)', async () => {
  // Exercises the TRUE branch of the WS-path `block.hash !== lastEmittedBlockHash`
  // check + the inner BigInt assignment + the blockSubs.emit call.
  // Setup: WS onData fires with a block whose hash differs from any prior
  // poll emission, so the source updates state and emits.
  let capturedOnData: ((data: unknown) => void) | null = null
  let getBlockCallCount = 0
  const blockA: BlockResult = {
    number: '0x10',
    hash: '0xaaa',
    parentHash: '0x0',
    timestamp: '0x1',
    baseFeePerGas: '0x0',
    gasLimit: '0x0',
    gasUsed: '0x0',
    transactions: [],
  }
  const blockB: BlockResult = { ...blockA, number: '0x11', hash: '0xbbb' }
  const subscribe = vi.fn(
    async (arg: {
      params: unknown[]
      onData: (data: unknown) => void
      onError: (err: unknown) => void
    }): Promise<{ unsubscribe: () => void }> => {
      if (arg.params[0] === 'newHeads') {
        // capture the second subscribe (live) — first is the probe.
        capturedOnData = arg.onData
      }
      return { unsubscribe: vi.fn() }
    },
  )
  const client = {
    transport: { type: 'webSocket', subscribe },
    request: vi.fn(async ({ method, params }: RpcCall) => {
      if (method === 'eth_getBlockByNumber') {
        // Distinguish tick fetches (fullTransactions=true) from the
        // adaptive scheduler's block-time estimation (fullTransactions=false).
        // Estimation calls fixed-shape; tick calls increment the counter.
        const [, full] = params as [string, boolean]
        if (full !== true) return blockA // estimation; doesn't matter
        getBlockCallCount += 1
        // First tick fetch returns blockA; later returns blockB.
        return getBlockCallCount === 1 ? blockA : blockB
      }
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      return null
    }),
  } as unknown as PublicClient

  const source = createChainSource({
    client,
    adaptivePolling: { enabled: false }, // simpler timing for this test
    pollIntervalMs: 1_000_000,
  })
  await source.ready()
  const received: BlockResult[] = []
  source.subscribeBlocks((b) => received.push(b))
  source.start()
  await flush()

  expect(capturedOnData).not.toBeNull()
  // WS onData fires — handleHeadNotification fetches latest (now blockB),
  // sees hash differs from lastEmittedBlockHash (0xaaa from poll), and
  // emits blockB.
  capturedOnData!(null)
  await flush()

  expect(received.map((b) => b.hash)).toEqual(['0xaaa', '0xbbb'])
  source.stop()
})

test('adaptive scheduler — early-return when stop() is called between ticks', async () => {
  // Exercises the `if (!started) return` guard inside
  // runAdaptiveTickAndSchedule. Setup: start the source, immediately
  // stop it, and confirm the scheduled tick does not fire after stop.
  let tickFires = 0
  const client = {
    transport: { type: 'http' },
    request: vi.fn(async (req: RpcCall) => {
      if (req.method === 'eth_blockNumber') return '0x10'
      if (req.method === 'eth_getBlockByNumber') {
        // Count only tick fetches (fullTransactions=true), not the
        // adaptive scheduler's estimation calls.
        const [, full] = req.params as [string, boolean]
        if (full === true) tickFires += 1
        return blockWithTs('0x10', '0xs', '0x1')
      }
      return null
    }),
  } as unknown as PublicClient

  const source = createChainSource({ client, pollIntervalMs: 100 })

  vi.useFakeTimers()
  try {
    source.start()
    // Let tick 1 fully resolve and schedule tick 2.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    const firesBefore = tickFires
    // Stop the source — tick 2 is queued in setTimeout, but the
    // started=false guard inside runAdaptiveTickAndSchedule must
    // bail before running tick.
    source.stop()
    // Advance well past where tick 2 would have fired.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(tickFires).toBe(firesBefore)
  } finally {
    vi.useRealTimers()
  }
})

