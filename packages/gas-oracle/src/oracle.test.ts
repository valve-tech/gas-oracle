import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'

import { createGasOracle, reducePollInputs } from './oracle.js'
import type { OraclePollInputs } from './transport.js'
import type { GasOracleState } from './types.js'

/* -------------------------------------------------------------------------- */
/*  reducePollInputs (pure function)                                          */
/* -------------------------------------------------------------------------- */

const baseFeeGwei = 1_000_000_000n // 1 gwei
const hex = (n: bigint) => '0x' + n.toString(16)

interface BlockOverrides {
  baseFee?: bigint
  transactions?: unknown[]
  excessBlobGas?: bigint
  blobGasUsed?: bigint
}

const blockOnly = (overrides: BlockOverrides = {}): OraclePollInputs => {
  const block: OraclePollInputs['block'] = {
    number: '0x1234',
    timestamp: '0x660a0000',
    baseFeePerGas: hex(overrides.baseFee ?? baseFeeGwei),
    gasLimit: '0x1c9c380',
    gasUsed: '0xe4e1c0',
    transactions: (overrides.transactions ?? []) as never,
  }
  if (overrides.excessBlobGas !== undefined) block.excessBlobGas = hex(overrides.excessBlobGas)
  if (overrides.blobGasUsed !== undefined) block.blobGasUsed = hex(overrides.blobGasUsed)
  return { feeHistory: null, block, txPool: null }
}

describe('reducePollInputs', () => {
  it('returns null when no block is available (cycle aborts)', () => {
    expect(reducePollInputs({
      inputs: { feeHistory: null, block: null, txPool: null },
      chainId: 1,
      prev: null,
    })).toBeNull()
  })

  it('builds a state from a minimal block-only input', () => {
    const next = reducePollInputs({
      inputs: blockOnly(),
      chainId: 369,
      prev: null,
    })
    expect(next).not.toBeNull()
    expect(next!.chainId).toBe(369)
    expect(next!.blockNumber).toBe(0x1234n)
    expect(next!.baseFee).toBe(baseFeeGwei)
    expect(next!.tiers.slow).toBeDefined()
    expect(next!.mempool.pendingCount).toBe(0)
    expect(next!.blob).toBeNull()
  })

  it('uses block.transactions for the merged distribution when txs are present', () => {
    // Two legacy txs at 101 gwei effective → every paying-lane tier
    // should land at 100 gwei. The zero-priority 1559 tx contributes a
    // 0n sample that drags p10 down (gas-weighted at 1/3 of the
    // distribution); standard/fast/instant ride the paying lane.
    const legacyHex = hex(101_000_000_000n)
    const next = reducePollInputs({
      inputs: blockOnly({
        transactions: [
          { gasPrice: legacyHex, gas: '0x5208', type: '0x0' },
          { gasPrice: legacyHex, gas: '0x5208', type: '0x0' },
          { maxPriorityFeePerGas: '0x0', maxFeePerGas: hex(baseFeeGwei), gas: '0x5208', type: '0x2' },
        ],
      }),
      chainId: 1,
      prev: null,
    })
    expect(next!.tiers.fast.maxPriorityFeePerGas).toBe(100_000_000_000n)
    expect(next!.tiers.instant.maxPriorityFeePerGas).toBe(100_000_000_000n)
    expect(next!.tiers.standard.maxPriorityFeePerGas).toBe(100_000_000_000n)
  })

  it('produces zero-tier output for an empty block', () => {
    // No txs → no samples → every percentile is 0n; tiers reflect that
    // verbatim now that there is no minPriorityFee floor and no
    // feeHistory.reward fallback.
    const inputs: OraclePollInputs = {
      feeHistory: {
        baseFeePerGas: [hex(baseFeeGwei)],
        reward: [['0x64', '0xc8', '0x1f4', '0x3e8', '0x7d0']],
        gasUsedRatio: [0.5],
        oldestBlock: '0x100',
      },
      block: blockOnly().block,
      txPool: null,
    }
    const next = reducePollInputs({ inputs, chainId: 1, prev: null })
    expect(next!.tiers.slow.maxPriorityFeePerGas).toBe(0n)
    expect(next!.tiers.instant.maxPriorityFeePerGas).toBe(0n)
  })

  it('uses block.transactions verbatim regardless of feeHistory.reward', () => {
    // feeHistory.reward is no longer consulted by the producer; the
    // merged-distribution rule reads samples directly off block.transactions.
    const inputs: OraclePollInputs = {
      feeHistory: {
        baseFeePerGas: [hex(baseFeeGwei)],
        reward: [['0x0', '0x0', '0x0', '0x0', '0x0']],
        gasUsedRatio: [0.5],
        oldestBlock: '0x100',
      },
      block: blockOnly({
        transactions: [
          { gasPrice: hex(101_000_000_000n), gas: '0x5208', type: '0x0' },
        ],
      }).block,
      txPool: null,
    }
    const next = reducePollInputs({ inputs, chainId: 1, prev: null })
    // Single sample → every tier reads that tip
    expect(next!.tiers.standard.maxPriorityFeePerGas).toBe(100_000_000_000n)
  })

  it('populates mempool stats when txPool is present', () => {
    const inputs: OraclePollInputs = {
      feeHistory: null,
      block: blockOnly().block,
      txPool: {
        pending: {
          '0xabc': { '0': { maxPriorityFeePerGas: '0x12c', maxFeePerGas: hex(2_000_000_000n), gas: '0x5208', type: '0x2' } },
        },
        queued: {
          '0xdef': { '0': { gasPrice: hex(2_000_000_000n), gas: '0x5208', type: '0x0' } },
        },
      },
    }
    const next = reducePollInputs({ inputs, chainId: 1, prev: null })
    expect(next!.mempool.pendingCount).toBe(1)
    expect(next!.mempool.queuedCount).toBe(1)
    expect(next!.mempool.pendingGasDemand).toBe(21000n)
  })

  it('populates blob stats when the block exposes excessBlobGas', () => {
    const next = reducePollInputs({
      inputs: blockOnly({ excessBlobGas: 0x100000n, blobGasUsed: 0x20000n }),
      chainId: 1,
      prev: null,
    })
    expect(next!.blob).not.toBeNull()
    expect(next!.blob!.excessBlobGas).toBe(0x100000n)
    expect(next!.blob!.blobBaseFee).toBeGreaterThan(0n)
  })

  it('omits blob stats on chains without excessBlobGas', () => {
    const next = reducePollInputs({ inputs: blockOnly(), chainId: 1, prev: null })
    expect(next!.blob).toBeNull()
  })

  it('threads lastPublishedTips through to the next-cycle cap anchor', () => {
    const prev: GasOracleState = reducePollInputs({
      inputs: blockOnly({
        transactions: [{ gasPrice: hex(5_000_000_000n + baseFeeGwei), gas: '0x5208', type: '0x0' }],
      }),
      chainId: 1,
      prev: null,
    })!
    expect(prev.lastPublishedTips).toBeDefined()
    expect(prev.lastPublishedBlockNumber).toBe(0x1234n)

    // Next block: tips collapse to zero. Cap should hold the floor at 7/8 of prev.
    const nextInputs = blockOnly()
    nextInputs.block!.number = '0x1235'
    const next = reducePollInputs({ inputs: nextInputs, chainId: 1, prev })!
    // 5_000_000_000 * 7/8 = 4_375_000_000
    expect(next.tiers.slow.maxPriorityFeePerGas).toBe(4_375_000_000n)
  })

  it('suppresses whipsaw on the standard tier when the next block prints zero', () => {
    // Customer-facing scenario: paying-lane validators bid 5000 gwei on
    // block N; block N+1 lands empty (or all spam-lane). Without the cap
    // the customer would see standard collapse to 0 and underbid the
    // very next block. The cap holds it at 5000 * 7/8.
    const prev: GasOracleState = reducePollInputs({
      inputs: blockOnly({
        transactions: [
          { gasPrice: hex(5_000_000_000n + baseFeeGwei), gas: '0x5208', type: '0x0' },
        ],
      }),
      chainId: 1,
      prev: null,
    })!
    expect(prev.lastPublishedTips!.standard).toBe(5_000_000_000n)

    const nextInputs = blockOnly()
    nextInputs.block!.number = '0x1235'
    const next = reducePollInputs({ inputs: nextInputs, chainId: 1, prev })!
    expect(next.tiers.standard.maxPriorityFeePerGas).toBe(4_375_000_000n)
    expect(next.lastPublishedTips!.standard).toBe(4_375_000_000n)
  })

  it('lets rapid upside through the cap unclamped', () => {
    // Reverse direction: paying lane spikes 100x on the next block; the
    // cap must not impede upside.
    const prev: GasOracleState = reducePollInputs({
      inputs: blockOnly({
        transactions: [
          { gasPrice: hex(500_000_000n + baseFeeGwei), gas: '0x5208', type: '0x0' },
        ],
      }),
      chainId: 1,
      prev: null,
    })!

    const nextInputs = blockOnly({
      transactions: [
        { gasPrice: hex(50_000_000_000n + baseFeeGwei), gas: '0x5208', type: '0x0' },
      ],
    })
    nextInputs.block!.number = '0x1235'
    const next = reducePollInputs({ inputs: nextInputs, chainId: 1, prev })!
    expect(next.tiers.standard.maxPriorityFeePerGas).toBe(50_000_000_000n)
  })

  it('populates ring with a single-element BlockSample (forward-compat)', () => {
    const next = reducePollInputs({
      inputs: blockOnly({
        transactions: [
          { gasPrice: hex(101_000_000_000n), gas: '0x5208', type: '0x0' },
        ],
      }),
      chainId: 1,
      prev: null,
    })!
    expect(next.ring).toHaveLength(1)
    expect(next.ring[0].number).toBe(0x1234n)
    expect(next.ring[0].tips).toHaveLength(1)
    expect(next.ring[0].tips[0].tip).toBe(100_000_000_000n)
  })
})

/* -------------------------------------------------------------------------- */
/*  createGasOracle (lifecycle)                                               */
/* -------------------------------------------------------------------------- */

interface FakeClient extends PublicClient {
  // not real, but matches what oracle calls
}

const stubClient = (
  responder: (method: string) => unknown = () => null,
): { client: FakeClient; request: ReturnType<typeof vi.fn> } => {
  const request = vi.fn(async (req: { method: string; params: unknown[] }) => {
    const r = responder(req.method)
    if (r instanceof Error) throw r
    return r
  })
  return { client: { request } as unknown as FakeClient, request }
}

const okBlock = () => ({
  number: '0x1234',
  timestamp: '0x660a0000',
  baseFeePerGas: hex(baseFeeGwei),
  gasLimit: '0x1c9c380',
  gasUsed: '0xe4e1c0',
  transactions: [],
})

const okFeeHistory = () => ({
  baseFeePerGas: Array.from({ length: 21 }, () => hex(baseFeeGwei)),
  reward: Array.from({ length: 20 }, () => ['0x0', '0x0', '0x0', '0x0', '0x0']),
  gasUsedRatio: Array.from({ length: 20 }, () => 0.5),
  oldestBlock: '0x100',
})

const flush = async () => {
  // Allow the async `cycle()` chain to resolve. fake timers + microtasks need
  // both an immediate microtask drain and a tick to settle.
  await Promise.resolve()
  await Promise.resolve()
}

describe('createGasOracle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('exposes null state until the first poll completes', () => {
    const { client } = stubClient(() => null)
    const oracle = createGasOracle({ client, chainId: 1 })
    expect(oracle.getState()).toBeNull()
  })

  it('populates state after pollOnce()', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({ client, chainId: 369 })
    const state = await oracle.pollOnce()
    expect(state).not.toBeNull()
    expect(state!.chainId).toBe(369)
    expect(oracle.getState()).toEqual(state)
  })

  it('returns null from pollOnce when the block fetch fails', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return new Error('rpc down')
      return okFeeHistory()
    })
    const oracle = createGasOracle({ client, chainId: 1 })
    expect(await oracle.pollOnce()).toBeNull()
  })

  it('start() is idempotent — second call does not double-poll', async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    // Disable subscriber-gating + block-gating to test the v0.2.5-shape
    // base polling behavior. Subscriber-gated and block-gated paths are
    // exercised independently below.
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pollIntervalMs: 100,
      pauseWhenIdle: false,
      blockGatedPolling: false,
    })

    oracle.start()
    oracle.start() // no-op
    await flush()

    // Only one poll cycle = 3 RPC calls (feeHistory + block + txpool)
    expect(request).toHaveBeenCalledTimes(3)
    oracle.stop()
  })

  it('start() polls on the interval cadence', async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pollIntervalMs: 100,
      pauseWhenIdle: false,
      blockGatedPolling: false,
    })

    oracle.start()
    await flush() // initial poll
    await vi.advanceTimersByTimeAsync(100)
    await flush() // second poll

    // 2 cycles × 3 RPCs = 6 calls
    expect(request).toHaveBeenCalledTimes(6)
    oracle.stop()
  })

  it('stop() clears state and stops the interval', async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({ client, chainId: 1, pollIntervalMs: 100 })

    // Drive the first cycle deterministically — `start()` is fire-and-forget
    // so the cycle promise isn't awaitable through it.
    await oracle.pollOnce()
    expect(oracle.getState()).not.toBeNull()

    oracle.start() // attach the interval
    oracle.stop()
    expect(oracle.getState()).toBeNull()

    const beforeAdvance = request.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    expect(request.mock.calls.length).toBe(beforeAdvance)
  })

  it('subscribers fire on every successful cycle and unsubscribe cleanly', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({ client, chainId: 1, pollIntervalMs: 100 })

    const seen: GasOracleState[] = []
    const unsubscribe = oracle.subscribe((state) => seen.push(state))

    await oracle.pollOnce()
    expect(seen).toHaveLength(1)

    await oracle.pollOnce()
    expect(seen).toHaveLength(2)

    unsubscribe()
    await oracle.pollOnce()
    expect(seen).toHaveLength(2) // no growth after unsubscribe
  })

  it('isolates errors per subscriber so one bad consumer does not break others', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({ client, chainId: 1 })

    const good = vi.fn()
    oracle.subscribe(() => { throw new Error('subscriber blew up') })
    oracle.subscribe(good)

    await oracle.pollOnce()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('forwards per-method errors through onError', async () => {
    const { client } = stubClient((method) => {
      if (method === 'txpool_content') return new Error('method not found')
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const onError = vi.fn()
    const oracle = createGasOracle({ client, chainId: 1, onError })

    await oracle.pollOnce()
    expect(onError).toHaveBeenCalledWith('txpool_content', expect.any(Error))
  })

  it('throws when priorityFeeDecayCap is negative', () => {
    const { client } = stubClient(() => null)
    expect(() =>
      createGasOracle({ client, chainId: 1, priorityFeeDecayCap: -1n }),
    ).toThrow(/priorityFeeDecayCap/)
  })

  it('throws when priorityFeeDecayCap exceeds WAD', () => {
    const { client } = stubClient(() => null)
    const WAD = 1_000_000_000_000_000_000n
    expect(() =>
      createGasOracle({ client, chainId: 1, priorityFeeDecayCap: WAD + 1n }),
    ).toThrow(/priorityFeeDecayCap/)
  })

  it('accepts null as the explicit "no cap" sentinel', () => {
    const { client } = stubClient(() => null)
    expect(() =>
      createGasOracle({ client, chainId: 1, priorityFeeDecayCap: null }),
    ).not.toThrow()
  })

  it('throws when baseFeeLivenessBlocks is < 1', () => {
    const { client } = stubClient(() => null)
    expect(() =>
      createGasOracle({ client, chainId: 1, baseFeeLivenessBlocks: 0 }),
    ).toThrow(/baseFeeLivenessBlocks/)
  })

  it('throws when baseFeeLivenessBlocks is not an integer', () => {
    const { client } = stubClient(() => null)
    expect(() =>
      createGasOracle({ client, chainId: 1, baseFeeLivenessBlocks: 1.5 }),
    ).toThrow(/baseFeeLivenessBlocks/)
  })

  it('getMempoolSnapshot returns null by default (keepMempoolSnapshot off)', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      if (method === 'txpool_content') {
        return {
          pending: { '0xAaA': { '0x0': { gasPrice: '0x1', gas: '0x5208', type: '0x0' } } },
          queued: {},
        }
      }
      return null
    })
    const oracle = createGasOracle({ client, chainId: 1 })
    await oracle.pollOnce()
    expect(oracle.getMempoolSnapshot()).toBeNull()
  })

  it('getMempoolSnapshot returns the normalized pool when keepMempoolSnapshot is on', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      if (method === 'txpool_content') {
        return {
          pending: {
            '0xAbCdEf1234567890123456789012345678901234': {
              '0x5': { gasPrice: '0x1', gas: '0x5208', type: '0x0', hash: '0xtx' },
            },
          },
          queued: {},
        }
      }
      return null
    })
    const oracle = createGasOracle({ client, chainId: 1, keepMempoolSnapshot: true })
    await oracle.pollOnce()
    const snap = oracle.getMempoolSnapshot()
    expect(snap).not.toBeNull()
    // Address lowercased, nonce decimalized
    expect(snap!.pending['0xabcdef1234567890123456789012345678901234']).toBeDefined()
    expect(snap!.pending['0xabcdef1234567890123456789012345678901234']['5']).toBeDefined()
  })

  it('stop() clears the mempool snapshot too', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      if (method === 'txpool_content') {
        return {
          pending: { '0xAaA': { '0x0': { gasPrice: '0x1', gas: '0x5208', type: '0x0' } } },
          queued: {},
        }
      }
      return null
    })
    const oracle = createGasOracle({ client, chainId: 1, keepMempoolSnapshot: true })
    await oracle.pollOnce()
    expect(oracle.getMempoolSnapshot()).not.toBeNull()
    oracle.stop()
    expect(oracle.getMempoolSnapshot()).toBeNull()
  })

  it('threads baseFeeLivenessBlocks into the buffer math', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    // With trend='stable' (no fee history → defaults to stable detected),
    // a 6-block liveness window should make maxFeePerGas substantially
    // larger than the 1-block default.
    const oracle1 = createGasOracle({ client, chainId: 1 })
    const oracle6 = createGasOracle({ client, chainId: 1, baseFeeLivenessBlocks: 6 })

    const state1 = await oracle1.pollOnce()
    const state6 = await oracle6.pollOnce()

    expect(state1).not.toBeNull()
    expect(state6).not.toBeNull()
    expect(state6!.tiers.fast.maxFeePerGas).toBeGreaterThan(
      state1!.tiers.fast.maxFeePerGas,
    )
  })

  it('threads poll toggles into the upstream RPC fan-out', async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      poll: { feeHistory: false, mempool: false },
    })

    await oracle.pollOnce()

    // Only the block call should have fired
    const methods = request.mock.calls.map((c) => c[0].method)
    expect(methods).toEqual(['eth_getBlockByNumber'])
  })

  it("priorityModel='eip1559' yields different paying-lane tiers than 'flat' on a mixed-type block", async () => {
    // 5 type-0 zero-tip txs + 1 type-2 high-tip tx. Under 'flat' the spam
    // dominates and pulls the paying lanes near zero; under 'eip1559' the
    // type-2 sample carries the entire paying-lane distribution.
    const mixedBlock = (): OraclePollInputs['block'] => ({
      number: '0x1234',
      timestamp: '0x660a0000',
      baseFeePerGas: hex(baseFeeGwei),
      gasLimit: '0x1c9c380',
      gasUsed: '0xe4e1c0',
      transactions: [
        { gasPrice: hex(baseFeeGwei), gas: '0x5208', type: '0x0' },
        { gasPrice: hex(baseFeeGwei), gas: '0x5208', type: '0x0' },
        { gasPrice: hex(baseFeeGwei), gas: '0x5208', type: '0x0' },
        { gasPrice: hex(baseFeeGwei), gas: '0x5208', type: '0x0' },
        { gasPrice: hex(baseFeeGwei), gas: '0x5208', type: '0x0' },
        { maxPriorityFeePerGas: hex(99_000_000_000n), maxFeePerGas: hex(200_000_000_000n), gas: '0x5208', type: '0x2' },
      ] as never,
    })

    const buildOracle = (priorityModel: 'flat' | 'eip1559') => {
      const { client } = stubClient((method) => {
        if (method === 'eth_getBlockByNumber') return mixedBlock()
        return null
      })
      return createGasOracle({ client, chainId: 1, priorityModel })
    }

    const flat = await buildOracle('flat').pollOnce()
    const eip = await buildOracle('eip1559').pollOnce()

    expect(flat).not.toBeNull()
    expect(eip).not.toBeNull()
    // 'eip1559' fast tier should be much higher because it ignored spam
    expect(eip!.tiers.fast.maxPriorityFeePerGas).toBeGreaterThan(
      flat!.tiers.fast.maxPriorityFeePerGas,
    )
  })

  /* ------------------------------------------------------------------------ */
  /*  Subscriber-gated polling (pauseWhenIdle, default true)                  */
  /* ------------------------------------------------------------------------ */

  it('pauseWhenIdle (default) — start() does not poll without a subscriber', async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_blockNumber') return '0x1234'
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({ client, chainId: 1, pollIntervalMs: 100 })

    oracle.start()
    await flush()
    await vi.advanceTimersByTimeAsync(500)
    await flush()

    // No subscribers → loop never fires → no RPC calls.
    expect(request).not.toHaveBeenCalled()
    oracle.stop()
  })

  it('pauseWhenIdle — first subscriber resumes the loop and emits a fresh sample', async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_blockNumber') return '0x1234'
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pollIntervalMs: 100,
      blockGatedPolling: false, // isolate subscriber-gating from block-gating
    })
    oracle.start()
    await flush()
    expect(request).not.toHaveBeenCalled()

    const cb = vi.fn()
    const unsubscribe = oracle.subscribe(cb)
    // The cycle is fire-and-forget — drain microtasks until notify() runs.
    // fetchOracleInputs awaits Promise.all([3 safeRequests]) which is
    // multiple microtasks deep, so a couple of resolves aren't enough.
    for (let i = 0; i < 10; i++) await Promise.resolve()

    // First subscriber → immediate cycle fired.
    expect(request).toHaveBeenCalledTimes(3)
    expect(cb).toHaveBeenCalledTimes(1)

    unsubscribe()
    oracle.stop()
  })

  it('pauseWhenIdle — last unsubscriber pauses the loop (staleAfter: 0)', async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_blockNumber') return '0x1234'
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pollIntervalMs: 100,
      blockGatedPolling: false,
    })
    oracle.start()
    const unsubscribe = oracle.subscribe(() => {})
    await flush()
    const callsAfterFirstCycle = request.mock.calls.length
    expect(callsAfterFirstCycle).toBeGreaterThan(0)

    unsubscribe()
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    // Loop is paused → no further calls.
    expect(request).toHaveBeenCalledTimes(callsAfterFirstCycle)
    oracle.stop()
  })

  it('pauseWhenIdle + staleAfter — keeps loop alive after last unsubscribe for the window', async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_blockNumber') return '0x1234'
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pollIntervalMs: 100,
      blockGatedPolling: false,
      staleAfter: 250,
    })
    oracle.start()
    const unsubscribe = oracle.subscribe(() => {})
    await flush()
    const callsAfterSubscribe = request.mock.calls.length

    unsubscribe()
    // Within the staleAfter window, the loop continues.
    await vi.advanceTimersByTimeAsync(100)
    await flush()
    expect(request.mock.calls.length).toBeGreaterThan(callsAfterSubscribe)

    // After staleAfter expires, the loop pauses.
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    const callsAfterPause = request.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    expect(request).toHaveBeenCalledTimes(callsAfterPause)
    oracle.stop()
  })

  it('pauseWhenIdle: false — start() polls immediately without subscriber (v0.2.5 behavior)', async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_blockNumber') return '0x1234'
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pollIntervalMs: 100,
      pauseWhenIdle: false,
      blockGatedPolling: false,
    })
    oracle.start()
    await flush()
    expect(request).toHaveBeenCalled()
    oracle.stop()
  })

  /* ------------------------------------------------------------------------ */
  /*  Block-gated polling (default true)                                      */
  /* ------------------------------------------------------------------------ */

  it('blockGatedPolling — second tick at the same head skips the full fan-out', async () => {
    let probeCount = 0
    let blockCount = 0
    const { client } = stubClient((method) => {
      if (method === 'eth_blockNumber') {
        probeCount += 1
        return '0x1234'
      }
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') {
        blockCount += 1
        return okBlock()
      }
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pollIntervalMs: 100,
      pauseWhenIdle: false,
    })
    oracle.start()
    await flush()
    // First cycle: lastSeenBlock is null → full fan-out.
    expect(probeCount).toBe(1)
    expect(blockCount).toBe(1)

    await vi.advanceTimersByTimeAsync(100)
    await flush()
    // Second cycle: head unchanged → probe only, no full fan-out.
    expect(probeCount).toBe(2)
    expect(blockCount).toBe(1)

    oracle.stop()
  })

  it('blockGatedPolling — head change on second tick triggers full fan-out', async () => {
    let blockCount = 0
    let nextHead = '0x1234'
    const { client } = stubClient((method) => {
      if (method === 'eth_blockNumber') return nextHead
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') {
        blockCount += 1
        return { ...okBlock(), number: nextHead }
      }
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pollIntervalMs: 100,
      pauseWhenIdle: false,
    })
    oracle.start()
    await flush()
    expect(blockCount).toBe(1)

    nextHead = '0x1235' // head moved
    await vi.advanceTimersByTimeAsync(100)
    await flush()
    expect(blockCount).toBe(2)

    oracle.stop()
  })

  it('pollOnce always bypasses block-gating', async () => {
    let blockCount = 0
    const { client } = stubClient((method) => {
      if (method === 'eth_blockNumber') return '0x1234'
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') {
        blockCount += 1
        return okBlock()
      }
      return null
    })
    const oracle = createGasOracle({ client, chainId: 1 })
    await oracle.pollOnce()
    await oracle.pollOnce()
    await oracle.pollOnce()
    // All three pollOnce calls should fire fullCycle, even though the
    // head is identical across all three.
    expect(blockCount).toBe(3)
  })

  /* ------------------------------------------------------------------------ */
  /*  pauseWhenHidden (browser visibility)                                    */
  /* ------------------------------------------------------------------------ */

  it('pauseWhenHidden — pauses on visibilitychange when document.hidden becomes true', async () => {
    // Stub a minimal document on globalThis.
    const listeners: Array<() => void> = []
    let hidden = false
    const stubDoc = {
      get hidden() { return hidden },
      addEventListener: (_: string, cb: () => void) => { listeners.push(cb) },
      removeEventListener: (_: string, cb: () => void) => {
        const i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
      },
    }
    ;(globalThis as { document?: typeof stubDoc }).document = stubDoc

    const { client, request } = stubClient((method) => {
      if (method === 'eth_blockNumber') return '0x1234'
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pollIntervalMs: 100,
      pauseWhenIdle: false,
      blockGatedPolling: false,
      pauseWhenHidden: true,
    })
    oracle.start()
    await flush()
    const callsBeforeHide = request.mock.calls.length
    expect(callsBeforeHide).toBeGreaterThan(0)

    // Simulate tab going hidden.
    hidden = true
    listeners.forEach((cb) => cb())
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    expect(request).toHaveBeenCalledTimes(callsBeforeHide)

    // Simulate tab becoming visible — loop resumes.
    hidden = false
    listeners.forEach((cb) => cb())
    await flush()
    expect(request.mock.calls.length).toBeGreaterThan(callsBeforeHide)

    oracle.stop()
    delete (globalThis as { document?: typeof stubDoc }).document
  })
})
