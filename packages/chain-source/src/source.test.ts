import { test, expect, vi } from 'vitest'
import type { PublicClient } from 'viem'

import { createChainSource } from './source.js'
import type {
  BlockResult,
  FeeHistoryResult,
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

    const blockCalls = calls.filter((c) => c.method === 'eth_getBlockByNumber')
    // One immediate tick (not two — start is idempotent), interval not
    // yet fired (interval is 1M ms).
    expect(blockCalls).toHaveLength(1)

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
