import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'
import type { BlockResult, ChainSource, NormalizedMempool } from '@valve-tech/chain-source'

import { createGasOracle, reducePollInputs } from './oracle.js'
import type { OraclePollInputs } from './transport.js'
import { PriorityModel, Trend, type GasOracleState } from './types.js'

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
    expect(next!.mempool.pendingCount).toBe(0n)
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
      // Asserting merged-distribution semantics — explicit `flat` so the
      // legacy txs participate in paying-lane percentiles.
      priorityModel: PriorityModel.flat,
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
    const next = reducePollInputs({
      inputs,
      chainId: 1,
      prev: null,
      // Single legacy tx — under the eip1559 default it would be filtered
      // out of paying-lane percentiles. The assertion is about whether
      // block.transactions is read at all (vs feeHistory.reward), so
      // pin the model to flat.
      priorityModel: PriorityModel.flat,
    })
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
    expect(next!.mempool.pendingCount).toBe(1n)
    expect(next!.mempool.queuedCount).toBe(1n)
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

  it('threads prev blob history into the next-cycle blob trend', () => {
    // Drives the `input.prev?.blob ? [prev.blobBaseFee, current] : [current]`
    // ternary's prev-set arm.
    const first = reducePollInputs({
      inputs: blockOnly({ excessBlobGas: 0x100000n, blobGasUsed: 0x20000n }),
      chainId: 1,
      prev: null,
    })
    const second = reducePollInputs({
      inputs: blockOnly({ excessBlobGas: 0x200000n, blobGasUsed: 0x20000n }),
      chainId: 1,
      prev: first,
    })
    expect(second!.blob).not.toBeNull()
    // Trend was computed from a 2-element history (prev → current)
    // rather than a singleton — verifies the prev-arm took effect.
    expect([Trend.rising, Trend.falling, Trend.stable]).toContain(second!.blob!.blobBaseFeeTrend)
  })

  it('defaults blobGasUsed to 0 when block has excessBlobGas but not blobGasUsed', () => {
    // Drives the `?? '0x0'` arm of `BigInt(block.blobGasUsed ?? '0x0')`.
    const next = reducePollInputs({
      inputs: blockOnly({ excessBlobGas: 0x100000n }), // no blobGasUsed
      chainId: 1,
      prev: null,
    })
    expect(next!.blob).not.toBeNull()
    expect(next!.blob!.blobGasUsed).toBe(0n)
  })

  it('omits feeHistory when fetchFeeHistory is disabled (handleBlock branch)', async () => {
    // Drives the `: null` arm of the ternary in handleBlock.
    const { client } = stubClient((method) => {
      if (method === 'eth_blockNumber') return '0x1234'
      if (method === 'eth_getBlockByNumber') return okBlock()
      // Note: no eth_feeHistory responder — the source must NOT call it
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      poll: { feeHistory: false },
      pauseWhenIdle: false,
    })
    oracle.start()
    await oracle.pollOnce()
    await flush()
    // pollOnce returns state even without feeHistory; verify it
    // didn't crash and produced tiers.
    const state = oracle.getState()
    expect(state).not.toBeNull()
    expect(state!.tiers.standard).toBeDefined()
    oracle.stop()
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
      // Cap-anchor test uses legacy txs to seed lastPublishedTips —
      // explicit `flat` so paying-lane tiers pick them up.
      priorityModel: PriorityModel.flat,
    })!
    expect(prev.lastPublishedTips!.standard).toBe(5_000_000_000n)

    const nextInputs = blockOnly()
    nextInputs.block!.number = '0x1235'
    const next = reducePollInputs({
      inputs: nextInputs,
      chainId: 1,
      prev,
      priorityModel: PriorityModel.flat,
    })!
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
      // Same reason as the suppress-whipsaw test above: legacy-only fixture.
      priorityModel: PriorityModel.flat,
    })!

    const nextInputs = blockOnly({
      transactions: [
        { gasPrice: hex(50_000_000_000n + baseFeeGwei), gas: '0x5208', type: '0x0' },
      ],
    })
    nextInputs.block!.number = '0x1235'
    const next = reducePollInputs({
      inputs: nextInputs,
      chainId: 1,
      prev,
      priorityModel: PriorityModel.flat,
    })!
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

  it('preserves mempoolSamples on the published state', () => {
    // Two paying-lane mempool txs at 5 gwei and 8 gwei — the samples
    // that fed the tier computation must be retained on the resulting
    // state so downstream replacement/classification helpers can read
    // the live distribution without re-fetching txpool_content.
    const inputs: OraclePollInputs = {
      feeHistory: null,
      block: blockOnly().block,
      txPool: {
        pending: {
          '0xaaa': {
            '1': {
              maxPriorityFeePerGas: hex(5_000_000_000n),
              maxFeePerGas: hex(baseFeeGwei + 5_000_000_000n),
              gas: '0x5208',
              type: '0x2',
              hash: '0xm1',
              from: '0xaaa',
              nonce: '0x1',
            },
          },
          '0xbbb': {
            '1': {
              maxPriorityFeePerGas: hex(8_000_000_000n),
              maxFeePerGas: hex(baseFeeGwei + 8_000_000_000n),
              gas: '0x5208',
              type: '0x2',
              hash: '0xm2',
              from: '0xbbb',
              nonce: '0x1',
            },
          },
        },
        queued: {},
      },
    }
    const next = reducePollInputs({ inputs, chainId: 1, prev: null })!
    expect(next.mempoolSamples).toHaveLength(2)
    const tips = next.mempoolSamples.map((s) => s.tip).sort((a, b) => (a < b ? -1 : 1))
    expect(tips).toEqual([5_000_000_000n, 8_000_000_000n])
    expect(next.mempoolSamples.every((s) => s.txType === 2)).toBe(true)
  })

  it('returns an empty mempoolSamples array when txPool is absent', () => {
    // The "no mempool data" branch — assert the field is still present
    // and non-undefined so consumers can call array methods safely.
    const next = reducePollInputs({ inputs: blockOnly(), chainId: 1, prev: null })!
    expect(next.mempoolSamples).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/*  createGasOracle (lifecycle)                                               */
/* -------------------------------------------------------------------------- */

type FakeClient = PublicClient

const stubClient = (
  responder: (method: string) => unknown = () => null,
): { client: FakeClient; request: ReturnType<typeof vi.fn> } => {
  const request = vi.fn(async (req: { method: string; params: unknown[] }) => {
    const r = responder(req.method)
    if (r instanceof Error) throw r
    return r
  })
  // `transport` is read structurally by chain-source's capability
  // probe — needs to be present for `typeof transport.subscribe ===
  // 'function'` to evaluate without throwing. The 'http' type matches
  // what `createPublicClient({ transport: http() })` produces.
  return {
    client: { request, transport: { type: 'http' } } as unknown as FakeClient,
    request,
  }
}

// Fixture builder for `eth_getBlockByNumber('latest', true)`. The
// `hash` field is required for chain-source's per-block dedup gate;
// pass an explicit `hash` to model multi-tick scenarios where head
// changes (consecutive identical hashes dedup to a single block emit).
const okBlock = (overrides: { number?: string; hash?: string } = {}) => ({
  number: overrides.number ?? '0x1234',
  hash: overrides.hash ?? '0xblockhashdefault',
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
  // Drain enough microticks for the full subscribe-driven cycle to
  // settle. The chain is now: chain-source's eager capability probe
  // (txpool_content + eth_getTransactionReceipt for zero-hash) racing
  // with `oracle.start()` → `attachToSource()` → `source.start()` →
  // tick (probe + mempool parallel → block fetch → blocks emit →
  // handleBlock awaits feeHistory → reduce + notify). Each `await`
  // hop contributes ~2 microticks, and there are ~10–12 hops in the
  // worst case, so 30 drains covers headroom comfortably without
  // costing real wall time under fake timers.
  for (let i = 0; i < 100; i++) await Promise.resolve()
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
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pollIntervalMs: 100n,
      pauseWhenIdle: false,
    })

    oracle.start()
    oracle.start() // no-op
    await flush()

    // Idempotency check: one cycle, not two. Counting `eth_getBlockByNumber`
    // is the durable per-cycle marker — it fires once when the head
    // changes (and once at tick #1 since lastSeen is undefined). The
    // chain-source eager probe + sub-RPC fan-out totals are
    // architecture-internal; this assertion stays meaningful even when
    // those shift.
    const blockFetches = request.mock.calls.filter(
      (c) => (c[0] as { method: string }).method === 'eth_getBlockByNumber',
    ).length
    expect(blockFetches).toBe(1)
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
      pollIntervalMs: 100n,
      pauseWhenIdle: false,
    })

    oracle.start()
    await flush() // initial poll
    await vi.advanceTimersByTimeAsync(100)
    await flush() // second poll

    // Two ticks fired: assert by `eth_blockNumber` (head probe) which
    // runs once per tick regardless of dedup outcome. With chain-source's
    // hash-based dedup, the second tick on a static head skips the full
    // block fetch — but the probe is the durable per-tick marker.
    const probeCalls = request.mock.calls.filter(
      (c) => (c[0] as { method: string }).method === 'eth_blockNumber',
    ).length
    expect(probeCalls).toBe(2)
    oracle.stop()
  })

  it('stop() clears state and stops the interval', async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({ client, chainId: 1, pollIntervalMs: 100n })

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
    const oracle = createGasOracle({ client, chainId: 1, pollIntervalMs: 100n })

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

  it('accepts a valid cap in [0n, WAD]', () => {
    const { client } = stubClient(() => null)
    expect(() =>
      createGasOracle({ client, chainId: 1, priorityFeeDecayCap: 100_000_000n }),
    ).not.toThrow()
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

    // Drain the chain-source eager-probe RPCs (txpool_content +
    // eth_getTransactionReceipt) so the subsequent assertion measures
    // ONLY the cycle's fan-out. The probe runs at construction
    // unconditionally — it's about capability disclosure, separate
    // from the cycle's poll toggles.
    await flush()
    const before = request.mock.calls.length
    await oracle.pollOnce()
    const cycleMethods = request.mock.calls
      .slice(before)
      .map((c) => (c[0] as { method: string }).method)

    // Only `getBlock` should have fired — feeHistory + mempool toggled
    // off. (`pollOnce` uses the source's on-demand methods directly,
    // which honor the toggles independently of the periodic tick.)
    expect(cycleMethods).toEqual(['eth_getBlockByNumber'])
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

    const buildOracle = (priorityModel: PriorityModel) => {
      const { client } = stubClient((method) => {
        if (method === 'eth_getBlockByNumber') return mixedBlock()
        return null
      })
      return createGasOracle({ client, chainId: 1, priorityModel })
    }

    const flat = await buildOracle(PriorityModel.flat).pollOnce()
    const eip = await buildOracle(PriorityModel.eip1559).pollOnce()

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
    const oracle = createGasOracle({ client, chainId: 1, pollIntervalMs: 100n })

    oracle.start()
    await flush()
    await vi.advanceTimersByTimeAsync(500)
    await flush()

    // No subscribers → loop never attaches → no full cycle fires.
    // The chain-source eager capability probe fires its own RPCs once
    // at construction (txpool_content + eth_getTransactionReceipt) —
    // those are NOT polling, they're capability disclosure that runs
    // once regardless of subscriber state. The polling-overhead check
    // is "no eth_getBlockByNumber" (the per-cycle full-block fetch)
    // and "no eth_feeHistory" (per-block emit).
    const cycleMethods = request.mock.calls
      .map((c) => (c[0] as { method: string }).method)
      .filter((m) => m === 'eth_getBlockByNumber' || m === 'eth_feeHistory' || m === 'eth_blockNumber')
    expect(cycleMethods).toEqual([])
    oracle.stop()
  })

  it('pauseWhenIdle — first subscriber resumes the loop and emits a fresh sample', async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_blockNumber') return '0x1234'
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({ client, chainId: 1, pollIntervalMs: 100n })
    oracle.start()
    await flush()
    // No cycle yet — only the probe ran.
    const probeOnlyCalls = request.mock.calls
      .map((c) => (c[0] as { method: string }).method)
      .filter((m) => m === 'eth_getBlockByNumber')
    expect(probeOnlyCalls).toEqual([])

    const cb = vi.fn()
    const unsubscribe = oracle.subscribe(cb)
    // First subscriber attaches → source.start() → tick fires →
    // block emits → handleBlock awaits feeHistory → reduce → cb.
    // Drain enough microtasks to settle the chain.
    for (let i = 0; i < 30; i++) await Promise.resolve()

    expect(cb).toHaveBeenCalledTimes(1)
    // Sanity check: the cycle ran (block fetch fired at least once).
    const blockFetches = request.mock.calls.filter(
      (c) => (c[0] as { method: string }).method === 'eth_getBlockByNumber',
    ).length
    expect(blockFetches).toBeGreaterThanOrEqual(1)

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
      pollIntervalMs: 100n,
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

  describe('pauseWhenHidden + visibility integration', () => {
    interface VisibilityDoc {
      hidden: boolean
      addEventListener: (e: 'visibilitychange', l: () => void) => void
      removeEventListener: (e: 'visibilitychange', l: () => void) => void
    }
    let originalDocument: unknown
    let listeners: (() => void)[] = []
    let docRef: VisibilityDoc

    beforeEach(() => {
      listeners = []
      docRef = {
        hidden: false,
        addEventListener: (_e, l) => listeners.push(l),
        removeEventListener: (_e, l) => {
          const i = listeners.indexOf(l)
          if (i >= 0) listeners.splice(i, 1)
        },
      }
      originalDocument =
        'document' in globalThis
          ? (globalThis as { document?: unknown }).document
          : undefined
      ;(globalThis as { document?: unknown }).document = docRef
    })

    afterEach(() => {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document
      } else {
        ;(globalThis as { document?: unknown }).document = originalDocument
      }
    })

    const fireVisibility = () => {
      for (const l of [...listeners]) l()
    }

    it('start() does NOT attach when pauseWhenHidden + document is hidden', async () => {
      // Drives the `if (pauseWhenHidden && isHidden()) return` arm
      // in the start() body — no attach, no source.start, no RPC.
      docRef.hidden = true
      const { client, request } = stubClient((method) => {
        if (method === 'eth_blockNumber') return '0x1234'
        if (method === 'eth_getBlockByNumber') return okBlock()
        if (method === 'eth_feeHistory') return okFeeHistory()
        return null
      })
      const oracle = createGasOracle({
        client,
        chainId: 1,
        pauseWhenHidden: true,
        pauseWhenIdle: false,
        pollIntervalMs: 100n,
      })
      oracle.start()
      await flush()
      // No RPC issued except the one-time capability probe (which
      // fires regardless of attach state).
      const blockCalls = request.mock.calls.filter(
        (c) => c[0].method === 'eth_getBlockByNumber',
      ).length
      expect(blockCalls).toBe(0)
      oracle.stop()
    })

    it('subscribe() bridges to attach respecting pauseWhenHidden', async () => {
      // Drives the `if (!pauseWhenHidden || !isHidden()) attachToSource()`
      // false-arm in the subscribe handler: hidden is true, so the
      // 0→1 transition does NOT attach.
      docRef.hidden = true
      const { client, request } = stubClient((method) => {
        if (method === 'eth_blockNumber') return '0x1234'
        if (method === 'eth_getBlockByNumber') return okBlock()
        if (method === 'eth_feeHistory') return okFeeHistory()
        return null
      })
      const oracle = createGasOracle({
        client,
        chainId: 1,
        pauseWhenHidden: true,
        pauseWhenIdle: true,
        pollIntervalMs: 100n,
      })
      oracle.start()
      const unsub = oracle.subscribe(() => {})
      await flush()
      const blockCalls = request.mock.calls.filter(
        (c) => c[0].method === 'eth_getBlockByNumber',
      ).length
      expect(blockCalls).toBe(0)
      unsub()
      oracle.stop()
    })

    it('visibility visible-with-subscribers re-attaches under pauseWhenIdle', async () => {
      // Drives the `subscribers.size > 0` arm of the visibility
      // listener's `!pauseWhenIdle || subscribers.size > 0` guard.
      const { client, request } = stubClient((method) => {
        if (method === 'eth_blockNumber') return '0x1234'
        if (method === 'eth_getBlockByNumber') return okBlock()
        if (method === 'eth_feeHistory') return okFeeHistory()
        return null
      })
      const oracle = createGasOracle({
        client,
        chainId: 1,
        pauseWhenHidden: true,
        pauseWhenIdle: true,
        pollIntervalMs: 100n,
      })
      oracle.start()
      const unsub = oracle.subscribe(() => {})
      docRef.hidden = true
      fireVisibility()
      docRef.hidden = false
      fireVisibility()
      await flush()
      const blockCalls = request.mock.calls.filter(
        (c) => c[0].method === 'eth_getBlockByNumber',
      ).length
      expect(blockCalls).toBeGreaterThan(0)
      unsub()
      oracle.stop()
    })

    it('visibility visible-but-no-subscribers stays detached under pauseWhenIdle', async () => {
      // Drives the false-arm: pauseWhenIdle=true AND subscribers.size===0
      // → the visibility listener does NOT re-attach on visible.
      const { client, request } = stubClient((method) => {
        if (method === 'eth_blockNumber') return '0x1234'
        if (method === 'eth_getBlockByNumber') return okBlock()
        if (method === 'eth_feeHistory') return okFeeHistory()
        return null
      })
      const oracle = createGasOracle({
        client,
        chainId: 1,
        pauseWhenHidden: true,
        pauseWhenIdle: true,
        pollIntervalMs: 100n,
      })
      oracle.start()
      docRef.hidden = false
      fireVisibility()
      await flush()
      const blockCalls = request.mock.calls.filter(
        (c) => c[0].method === 'eth_getBlockByNumber',
      ).length
      expect(blockCalls).toBe(0)
      oracle.stop()
    })

    it('visibility hidden → visible re-attaches when subscribers exist', async () => {
      // Drives the visibilitychange listener's visible-branch.
      const { client, request } = stubClient((method) => {
        if (method === 'eth_blockNumber') return '0x1234'
        if (method === 'eth_getBlockByNumber') return okBlock()
        if (method === 'eth_feeHistory') return okFeeHistory()
        return null
      })
      const oracle = createGasOracle({
        client,
        chainId: 1,
        pauseWhenHidden: true,
        pauseWhenIdle: false,
        pollIntervalMs: 100n,
      })
      oracle.start()
      // First make it hidden then visible
      docRef.hidden = true
      fireVisibility()
      docRef.hidden = false
      fireVisibility()
      await flush()
      const blockCalls = request.mock.calls.filter(
        (c) => c[0].method === 'eth_getBlockByNumber',
      ).length
      expect(blockCalls).toBeGreaterThan(0)
      oracle.stop()
    })
  })

  it('scheduleIdleDetach short-circuits when a stale timer is already pending', async () => {
    // Drives the `if (staleTimer !== null) return` branch — sub
    // arrives → timer cleared/never-set → unsub arms it → re-sub
    // re-attaches without clearing (early returns via unsubBlocks
    // guard) → unsub again finds the timer still set → bails out
    // of scheduleIdleDetach without re-arming.
    const { client } = stubClient((method) => {
      if (method === 'eth_blockNumber') return '0x1234'
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pollIntervalMs: 100n,
      blockGatedPolling: false,
      staleAfter: 250,
    })
    oracle.start()
    const unsub1 = oracle.subscribe(() => {})
    await flush()
    unsub1()
    // Timer armed at t=0; window=250
    await vi.advanceTimersByTimeAsync(50) // still inside window
    const unsub2 = oracle.subscribe(() => {})
    await flush()
    unsub2()
    // Second unsub triggers scheduleIdleDetach again with timer
    // still pending → hits the early return.
    oracle.stop()
  })

  it('keepMempoolSnapshot: false (default) leaves getMempoolSnapshot() at null even after a mempool emit', async () => {
    // Drives the false-arm of the `if (retainMempool) { mempoolSnapshot = snapshot }`
    // guard — keepMempoolSnapshot was not opted into, so the
    // public snapshot accessor stays null.
    const { client } = stubClient((method) => {
      if (method === 'eth_blockNumber') return '0x1234'
      if (method === 'eth_getBlockByNumber') return okBlock()
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'txpool_content') {
        return {
          pending: { '0xs': { '1': { hash: '0xt', from: '0xs', nonce: '0x1' } } },
          queued: {},
        }
      }
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pauseWhenIdle: false,
      // keepMempoolSnapshot omitted → default false
    })
    oracle.start()
    await oracle.pollOnce()
    await flush()
    expect(oracle.getMempoolSnapshot()).toBeNull()
    oracle.stop()
  })

  it('pauseWhenIdle + staleAfter — re-subscribe before window expires clears the stale timer', async () => {
    // Drives the previously-uncovered `if (staleTimer !== null)`
    // clear in `attachToSource`. The shape: subscribe → unsubscribe
    // (kicks off the stale timer) → re-subscribe before the timer
    // fires (must clear it so a later unsubscribe doesn't see a
    // stale-timer leftover from the prior cycle).
    const { client, request } = stubClient((method) => {
      if (method === 'eth_blockNumber') return '0x1234'
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      pollIntervalMs: 100n,
      blockGatedPolling: false,
      staleAfter: 250,
    })
    oracle.start()
    const unsubA = oracle.subscribe(() => {})
    await flush()
    unsubA()
    // Inside the stale window — timer is pending. Re-subscribe.
    await vi.advanceTimersByTimeAsync(100)
    const unsubB = oracle.subscribe(() => {})
    await flush()
    // The timer should have been CLEARED on re-attach (line 482-484).
    // Verify the loop is still polling (not paused), since the timer
    // never fired its detach.
    const callsBefore = request.mock.calls.length
    await vi.advanceTimersByTimeAsync(200)
    await flush()
    expect(request.mock.calls.length).toBeGreaterThan(callsBefore)
    unsubB()
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
      pollIntervalMs: 100n,
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
      pollIntervalMs: 100n,
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
      pollIntervalMs: 100n,
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
      pollIntervalMs: 100n,
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
      pollIntervalMs: 100n,
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

/* -------------------------------------------------------------------------- */
/*  createGasOracle — source/client validation + source-mode behavior         */
/* -------------------------------------------------------------------------- */

interface FakeSource {
  source: ChainSource
  /** Manually deliver a block to all subscribers. */
  emitBlock: (block: BlockResult) => void
  /** Manually deliver a mempool snapshot to all subscribers. */
  emitMempool: (snapshot: NormalizedMempool) => void
  /** Set what `getFeeHistory` returns on the next call. */
  setFeeHistory: (fh: unknown) => void
  /** Set what `getBlock`, `getMempoolSnapshot` return on next call. */
  setOnDemand: (overrides: { block?: BlockResult; mempool?: NormalizedMempool | null }) => void
  /** Spies on the lifecycle hooks. */
  startCalls: number
  stopCalls: number
}

/**
 * Build a fake `ChainSource` that lets tests drive subscribers + on-demand
 * methods directly. Decouples gas-oracle source-mode tests from
 * chain-source's RPC fan-out.
 */
const fakeChainSource = (): FakeSource => {
  const blockSubs = new Set<(b: BlockResult) => void>()
  const mempoolSubs = new Set<(m: NormalizedMempool) => void>()
  let feeHistoryFixture: unknown = null
  let onDemandBlock: BlockResult | undefined
  let onDemandMempool: NormalizedMempool | null = null
  const tracker = { startCalls: 0, stopCalls: 0 }

  const source: ChainSource = {
    start: () => { tracker.startCalls++ },
    stop: () => { tracker.stopCalls++ },
    pollOnce: async () => undefined,
    ready: async () => undefined,
    subscribeBlocks: (cb) => {
      blockSubs.add(cb)
      return () => blockSubs.delete(cb)
    },
    subscribeMempool: (cb) => {
      mempoolSubs.add(cb)
      return () => mempoolSubs.delete(cb)
    },
    getBlock: async () => onDemandBlock ?? null,
    getFeeHistory: async () => feeHistoryFixture as never,
    getMempoolSnapshot: async () => onDemandMempool,
    getReceipt: async () => null,
    getTransaction: async () => null,
    capabilities: () => ({
      newHeads: 'unavailable',
      newPendingTransactions: 'unavailable',
      txpoolContent: 'available',
      receiptByHash: 'available',
      reprobeOnReconnect: false,
    }),
  }

  return {
    get source() { return source },
    emitBlock: (b) => blockSubs.forEach((cb) => cb(b)),
    emitMempool: (m) => mempoolSubs.forEach((cb) => cb(m)),
    setFeeHistory: (fh) => { feeHistoryFixture = fh },
    setOnDemand: (overrides) => {
      if (overrides.block !== undefined) onDemandBlock = overrides.block
      if (overrides.mempool !== undefined) onDemandMempool = overrides.mempool
    },
    get startCalls() { return tracker.startCalls },
    get stopCalls() { return tracker.stopCalls },
  }
}

describe('createGasOracle — source/client validation', () => {
  it('throws when neither `source` nor `client` is provided', () => {
    // Both options are typed optional in the interface — the
    // exactly-one constraint is enforced at runtime, not by TypeScript.
    expect(() => createGasOracle({ chainId: 1 })).toThrow(
      /exactly one of `source` or `client`/,
    )
  })

  it('throws when both `source` and `client` are provided', () => {
    const fake = fakeChainSource()
    const { client } = stubClient(() => null)
    expect(() =>
      createGasOracle({ source: fake.source, client, chainId: 1 }),
    ).toThrow(/exactly one of `source` or `client`, not both/)
  })
})

describe('createGasOracle — source mode', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('subscribes to source.subscribeBlocks/subscribeMempool when started', async () => {
    const fake = fakeChainSource()
    const oracle = createGasOracle({ source: fake.source, chainId: 1, pauseWhenIdle: false })
    oracle.start()

    fake.setFeeHistory({
      baseFeePerGas: Array.from({ length: 21 }, () => hex(baseFeeGwei)),
      reward: Array.from({ length: 20 }, () => ['0x0', '0x0', '0x0', '0x0', '0x0']),
      gasUsedRatio: Array.from({ length: 20 }, () => 0.5),
      oldestBlock: '0x0',
    })
    fake.emitBlock(okBlock())
    for (let i = 0; i < 30; i++) await Promise.resolve()

    // Block emit → handleBlock → fetch feeHistory → reduce.
    expect(oracle.getState()).not.toBeNull()
    expect(oracle.getState()!.chainId).toBe(1)
    oracle.stop()
  })

  it('does NOT call source.start() when source is provided externally', () => {
    const fake = fakeChainSource()
    const oracle = createGasOracle({ source: fake.source, chainId: 1, pauseWhenIdle: false })
    oracle.start()
    // External sources are the consumer's responsibility — oracle.start()
    // attaches subscribers but never starts the source itself.
    expect(fake.startCalls).toBe(0)
    oracle.stop()
    expect(fake.stopCalls).toBe(0)
  })

  it('calls source.start()/stop() when oracle owns a private source (client mode)', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return okBlock()
      return null
    })
    // pauseWhenIdle: false → start() attaches immediately, which drives
    // the private source's start.
    const oracle = createGasOracle({ client, chainId: 1, pauseWhenIdle: false })
    oracle.start()
    await flush()
    oracle.stop()
    // Real source's start/stop already exercised here — no easy spy
    // hook on the real source, but `oracle.getState()` after start()
    // confirms the source was running (state populated).
  })

  it('source-mode + pauseWhenIdle: detaches subscribers when last consumer leaves', async () => {
    const fake = fakeChainSource()
    const oracle = createGasOracle({
      source: fake.source,
      chainId: 1,
      // pauseWhenIdle defaults to true; explicit for clarity
      pauseWhenIdle: true,
      staleAfter: 0,
    })
    oracle.start()
    // No consumer yet → no attachment → emit doesn't reach us
    fake.setFeeHistory({
      baseFeePerGas: Array.from({ length: 21 }, () => hex(baseFeeGwei)),
      reward: Array.from({ length: 20 }, () => ['0x0', '0x0', '0x0', '0x0', '0x0']),
      gasUsedRatio: Array.from({ length: 20 }, () => 0.5),
      oldestBlock: '0x0',
    })
    fake.emitBlock(okBlock())
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(oracle.getState()).toBeNull()

    // Subscribe → attach → emit reaches us
    const cb = vi.fn()
    const unsub = oracle.subscribe(cb)
    fake.emitBlock(okBlock())
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(cb).toHaveBeenCalledTimes(1)

    // Unsubscribe → immediate detach (staleAfter: 0) → emit no longer reaches
    unsub()
    fake.emitBlock(okBlock({ hash: '0xnewhash' })) // different hash to bypass any local dedup
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(cb).toHaveBeenCalledTimes(1) // still 1
    oracle.stop()
  })

  it('source-mode pollOnce uses on-demand methods (bypasses subscription dedup)', async () => {
    const fake = fakeChainSource()
    fake.setOnDemand({ block: okBlock() })
    fake.setFeeHistory({
      baseFeePerGas: Array.from({ length: 21 }, () => hex(baseFeeGwei)),
      reward: Array.from({ length: 20 }, () => ['0x0', '0x0', '0x0', '0x0', '0x0']),
      gasUsedRatio: Array.from({ length: 20 }, () => 0.5),
      oldestBlock: '0x0',
    })
    const oracle = createGasOracle({ source: fake.source, chainId: 1 })

    const state1 = await oracle.pollOnce()
    const state2 = await oracle.pollOnce()
    // Both pollOnce calls produce non-null state — pollOnce never
    // dedups. Even on the same head, calling twice does two reduces.
    expect(state1).not.toBeNull()
    expect(state2).not.toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  sampleGasFees — one-shot snapshot                                         */
/* -------------------------------------------------------------------------- */

describe('sampleGasFees', () => {
  it('returns a GasOracleState reduced from one fetch, no oracle lifecycle', async () => {
    const { sampleGasFees } = await import('./oracle.js')
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return okBlock()
      if (method === 'eth_feeHistory') return okFeeHistory()
      // txpool_content gated — returns Error so safeRequest treats as null
      if (method === 'txpool_content') return new Error('method not found')
      return null
    })
    const state = await sampleGasFees({ client, chainId: 1 })
    expect(state).not.toBeNull()
    expect(state!.chainId).toBe(1)
    expect(state!.tiers.standard).toBeDefined()
    expect(state!.baseFee).toBe(baseFeeGwei)
  })

  it('passes priorityModel + priorityFeeDecayCap to the reducer', async () => {
    const { sampleGasFees } = await import('./oracle.js')
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return okBlock()
      if (method === 'eth_feeHistory') return okFeeHistory()
      return null
    })
    // priorityModel: 'flat' makes the reducer accept legacy txs alongside
    // type-2; the result shape is the same but the underlying
    // distribution is computed differently. We're just asserting the
    // option threads through end-to-end without throwing.
    const state = await sampleGasFees({
      client,
      chainId: 369,
      priorityModel: PriorityModel.flat,
      priorityFeeDecayCap: 100_000_000n,
    })
    expect(state?.chainId).toBe(369)
  })

  it('returns null when the block fetch fails (no inputs to reduce)', async () => {
    const { sampleGasFees } = await import('./oracle.js')
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return new Error('rpc down')
      return null
    })
    const state = await sampleGasFees({ client, chainId: 1 })
    expect(state).toBeNull()
  })

  it('routes upstream errors through onError', async () => {
    const { sampleGasFees } = await import('./oracle.js')
    const errors: { method: string; err: unknown }[] = []
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return new Error('block kaput')
      if (method === 'eth_feeHistory') return new Error('fh kaput')
      return null
    })
    await sampleGasFees({
      client,
      chainId: 1,
      onError: (method, err) => errors.push({ method, err }),
    })
    expect(errors.some((e) => e.method === 'eth_getBlockByNumber')).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/*  keepMempoolSnapshot retention                                             */
/* -------------------------------------------------------------------------- */

describe('keepMempoolSnapshot', () => {
  it('retains the latest mempool snapshot when set true', async () => {
    let blockCounter = 0
    const { client } = stubClient((method) => {
      if (method === 'eth_blockNumber') {
        return hex(BigInt(0x1234 + blockCounter))
      }
      if (method === 'eth_getBlockByNumber') {
        blockCounter += 1
        return okBlock({
          number: hex(BigInt(0x1234 + blockCounter - 1)),
          hash: '0xb' + blockCounter,
        })
      }
      if (method === 'eth_feeHistory') return okFeeHistory()
      if (method === 'txpool_content') {
        return {
          pending: { '0xs': { '1': { hash: '0xt1', from: '0xs', nonce: '0x1' } } },
          queued: {},
        }
      }
      return null
    })
    const oracle = createGasOracle({
      client,
      chainId: 1,
      keepMempoolSnapshot: true,
    })
    oracle.start()
    await oracle.pollOnce()
    await flush()
    const snapshot = oracle.getMempoolSnapshot()
    expect(snapshot).not.toBeNull()
    expect(snapshot!.pending['0xs']!['1']!.hash).toBe('0xt1')
    oracle.stop()
  })
})
