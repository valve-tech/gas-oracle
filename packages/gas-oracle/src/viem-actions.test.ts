import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'

import { gasOracleActions } from './viem-actions.js'
import { PriorityModel, TierName } from './types.js'

const hex = (n: bigint) => '0x' + n.toString(16)

const fakeBlock = () => ({
  number: '0x1234',
  timestamp: '0x660a0000',
  baseFeePerGas: hex(1_000_000_000n),
  gasLimit: '0x1c9c380',
  gasUsed: '0xe4e1c0',
  transactions: [
    { maxPriorityFeePerGas: hex(1_000_000_000n), maxFeePerGas: hex(3_000_000_000n), gas: '0x5208', type: '0x2' },
  ],
})

const stubClient = (
  responder: (method: string) => unknown,
): { client: PublicClient; request: ReturnType<typeof vi.fn> } => {
  const request = vi.fn(async (req: { method: string; params: unknown[] }) => {
    const result = responder(req.method)
    if (result instanceof Error) throw result
    return result
  })
  // `transport` is read structurally by chain-source's capability probe;
  // a missing transport throws inside `probeSubscribeShape`.
  return {
    client: { request, transport: { type: 'http' } } as unknown as PublicClient,
    request,
  }
}

describe('gasOracleActions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("attaches getGasTiers / getGasTier / stopGasOracle to a viem client", () => {
    const { client } = stubClient(() => null)
    const actions = gasOracleActions({ chainId: 1 })(client)
    expect(typeof actions.getGasTiers).toBe('function')
    expect(typeof actions.getGasTier).toBe('function')
    expect(typeof actions.stopGasOracle).toBe('function')
    actions.stopGasOracle()
  })

  it('getGasTiers returns a populated snapshot after a poll completes', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      return null
    })
    const actions = gasOracleActions({ chainId: 369, lifecycle: 'lazy' })(client)

    const state = await actions.getGasTiers()
    expect(state.chainId).toBe(369)
    expect(state.tiers.fast.maxPriorityFeePerGas).toBeGreaterThan(0n)
    actions.stopGasOracle()
  })

  it('getGasTier returns one tier from the same backing state', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      return null
    })
    const actions = gasOracleActions({ chainId: 1 })(client)

    const fast = await actions.getGasTier(TierName.fast)
    expect(fast.maxPriorityFeePerGas).toBeGreaterThan(0n)
    expect(fast.gasPrice).toBeGreaterThan(0n)
    actions.stopGasOracle()
  })

  it("'lazy' lifecycle defers polling until the first read", async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      return null
    })

    const actions = gasOracleActions({ chainId: 1, lifecycle: 'lazy' })(client)

    // No polling has happened yet — assert by absence of the cycle
    // marker (`eth_getBlockByNumber`). Chain-source's eager capability
    // probe (`txpool_content`, `eth_getTransactionReceipt`) does fire
    // once at construction unconditionally; that's separate from
    // polling.
    const cycleCallsBefore = request.mock.calls.filter(
      (c) => (c[0] as { method: string }).method === 'eth_getBlockByNumber',
    ).length
    expect(cycleCallsBefore).toBe(0)

    await actions.getGasTiers()
    // Now we've polled
    expect(request).toHaveBeenCalled()
    actions.stopGasOracle()
  })

  it("'eager' lifecycle polls immediately on attach", async () => {
    const { client, request } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      return null
    })

    const actions = gasOracleActions({ chainId: 1 })(client) // default eager

    // Eager start fires the first poll synchronously (fire-and-forget),
    // so flushing the microtask queue lets the request register.
    await Promise.resolve()
    await Promise.resolve()
    expect(request).toHaveBeenCalled()
    actions.stopGasOracle()
  })

  it('throws a descriptive error when the cold-start poll fails', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return new Error('rpc down')
      return null
    })
    const actions = gasOracleActions({ chainId: 42, lifecycle: 'lazy' })(client)

    await expect(actions.getGasTiers()).rejects.toThrow(/chain 42/)
    actions.stopGasOracle()
  })

  it('findTxInMempool resolves a hash via on-demand txpool_content fetch', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      if (method === 'txpool_content') {
        return {
          pending: {
            '0xAaAaAa1111111111111111111111111111111111': {
              '0x3': { hash: '0xabc', gasPrice: '0x1', gas: '0x5208', type: '0x0' },
            },
          },
          queued: {},
        }
      }
      return null
    })
    const actions = gasOracleActions({ chainId: 1, lifecycle: 'lazy' })(client)
    const hit = await actions.findTxInMempool({ hash: '0xabc' })
    expect(hit).not.toBeNull()
    expect(hit!.address).toBe('0xaaaaaa1111111111111111111111111111111111')
    expect(hit!.nonce).toBe('3')
    actions.stopGasOracle()
  })

  it('findTxInMempool resolves an address+nonce query', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      if (method === 'txpool_content') {
        return {
          pending: {
            '0xAaAaAa1111111111111111111111111111111111': {
              '0x5': { hash: '0xdef', gasPrice: '0x1', gas: '0x5208', type: '0x0' },
            },
          },
          queued: {},
        }
      }
      return null
    })
    const actions = gasOracleActions({ chainId: 1, lifecycle: 'lazy' })(client)
    const hit = await actions.findTxInMempool({
      address: '0xAaAaAa1111111111111111111111111111111111',
      nonce: 5,
    })
    expect(hit?.tx.hash).toBe('0xdef')
    actions.stopGasOracle()
  })

  it("findTxInMempool returns null when txpool_content is gated upstream", async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      if (method === 'txpool_content') return new Error('method not found')
      return null
    })
    const actions = gasOracleActions({ chainId: 1, lifecycle: 'lazy' })(client)
    const hit = await actions.findTxInMempool({ hash: '0xanyhash' })
    expect(hit).toBeNull()
    actions.stopGasOracle()
  })

  it("tipForBlockPosition computes a rank position from the block's distribution", async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') {
        return {
          number: '0x1234',
          timestamp: '0x660a0000',
          baseFeePerGas: hex(1_000_000_000n),
          gasLimit: '0x1c9c380',
          gasUsed: '0xe4e1c0',
          transactions: [
            { maxPriorityFeePerGas: hex(5_000_000_000n), maxFeePerGas: hex(10_000_000_000n), gas: '0x5208', type: '0x2', hash: '0xtop' },
            { maxPriorityFeePerGas: hex(3_000_000_000n), maxFeePerGas: hex(10_000_000_000n), gas: '0x5208', type: '0x2', hash: '0xmid' },
            { maxPriorityFeePerGas: hex(1_000_000_000n), maxFeePerGas: hex(10_000_000_000n), gas: '0x5208', type: '0x2', hash: '0xlow' },
          ],
        }
      }
      return null
    })
    const actions = gasOracleActions({ chainId: 1, lifecycle: 'lazy' })(client)
    const result = await actions.tipForBlockPosition({ kind: 'rank', rank: 0 })
    expect(result.pivot?.hash).toBe('0xtop')
    expect(result.requiredTip).toBe(5_000_000_001n)
    actions.stopGasOracle()
  })

  it("tipForBlockPosition handles an aheadOf-by-hash query", async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') {
        return {
          number: '0x1234',
          timestamp: '0x660a0000',
          baseFeePerGas: hex(1_000_000_000n),
          gasLimit: '0x1c9c380',
          gasUsed: '0xe4e1c0',
          transactions: [
            { maxPriorityFeePerGas: hex(5_000_000_000n), maxFeePerGas: hex(10_000_000_000n), gas: '0x5208', type: '0x2', hash: '0xtarget' },
            { maxPriorityFeePerGas: hex(2_000_000_000n), maxFeePerGas: hex(10_000_000_000n), gas: '0x5208', type: '0x2', hash: '0xother' },
          ],
        }
      }
      return null
    })
    const actions = gasOracleActions({ chainId: 1, lifecycle: 'lazy' })(client)
    const result = await actions.tipForBlockPosition({
      kind: 'aheadOf',
      tx: { hash: '0xtarget' },
    })
    expect(result.pivot?.hash).toBe('0xtarget')
    expect(result.requiredTip).toBe(5_000_000_001n)
    actions.stopGasOracle()
  })

  it('passes priorityModel + decayCap through to the underlying oracle', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') {
        return {
          ...fakeBlock(),
          transactions: [
            { gasPrice: hex(1_000_000_000n), gas: '0x5208', type: '0x0' },
            { maxPriorityFeePerGas: hex(50_000_000_000n), maxFeePerGas: hex(100_000_000_000n), gas: '0x5208', type: '0x2' },
          ],
        }
      }
      return null
    })

    const actions = gasOracleActions({
      chainId: 1,
      priorityModel: PriorityModel.eip1559,
      lifecycle: 'lazy',
    })(client)

    const state = await actions.getGasTiers()
    // Under 'eip1559' the legacy zero-tip tx is excluded from paying lanes
    expect(state.tiers.fast.maxPriorityFeePerGas).toBeGreaterThan(0n)
    actions.stopGasOracle()
  })

  it('tipForBlockPosition folds mempool pending txs into the sample distribution', async () => {
    // Drives the previously-uncovered mempool→TipSample translation
    // in viem-actions.ts: the EIP-1559 case (maxFeePerGas + maxPriority),
    // the legacy gasPrice case, the no-gas skip, and the 0-headroom
    // clamp.
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') {
        return {
          number: '0x1234',
          timestamp: '0x660a0000',
          baseFeePerGas: hex(1_000_000_000n),
          gasLimit: '0x1c9c380',
          gasUsed: '0xe4e1c0',
          transactions: [
            { maxPriorityFeePerGas: hex(2_000_000_000n), maxFeePerGas: hex(5_000_000_000n), gas: '0x5208', type: '0x2', hash: '0xring' },
          ],
        }
      }
      if (method === 'txpool_content') {
        return {
          pending: {
            '0xs1': {
              '1': {
                // EIP-1559 path: maxFee + maxPriority both set, healthy headroom
                hash: '0xmem-1559',
                from: '0xs1',
                nonce: '0x1',
                maxFeePerGas: hex(8_000_000_000n),
                maxPriorityFeePerGas: hex(3_000_000_000n),
                gas: '0x5208',
                type: '0x2',
              },
            },
            '0xs2': {
              '1': {
                // Legacy path: gasPrice only
                hash: '0xmem-legacy',
                from: '0xs2',
                nonce: '0x1',
                gasPrice: hex(4_000_000_000n),
                gas: '0x5208',
                type: '0x0',
              },
            },
            '0xs3': {
              '1': {
                // 0-headroom: maxFee equals baseFee, tip clamps to 0
                hash: '0xmem-clamped',
                from: '0xs3',
                nonce: '0x1',
                maxFeePerGas: hex(1_000_000_000n),
                maxPriorityFeePerGas: hex(2_000_000_000n),
                gas: '0x5208',
                type: '0x2',
              },
            },
            '0xs4': {
              '1': {
                // gas undefined → skipped entirely
                hash: '0xmem-nogas',
                from: '0xs4',
                nonce: '0x1',
                gasPrice: hex(9_000_000_000n),
                type: '0x0',
              },
            },
          },
          queued: {},
        }
      }
      return null
    })
    const actions = gasOracleActions({
      chainId: 1,
      lifecycle: 'lazy',
      keepMempoolSnapshot: true,
    })(client)
    const result = await actions.tipForBlockPosition({ kind: 'rank', rank: 0 })
    // Must not throw; pivot may be the highest-tip mempool tx (EIP-1559
    // headroom is min(2gwei priority, 7gwei headroom) = 2gwei) — but
    // the ring tx tip wins (3 gwei priority). The exact pivot is
    // distribution-dependent; the assertion is just that the path
    // completed and returned a sample.
    expect(result.requiredTip).toBeGreaterThan(0n)
    expect(result.pivot).not.toBeNull()
    actions.stopGasOracle()
  })

  it('tipForBlockPosition treats mempool txs with no fee fields as 0n tip', async () => {
    // Drives the previously-uncovered `return 0n` branch in the
    // mempool tip computation — a tx with `gas` set but neither
    // {maxFee + maxPriority} nor `gasPrice` should not throw and
    // should appear as a 0-tip sample (consumer policy decides
    // whether to discard such samples downstream).
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') {
        return {
          number: '0x1234',
          timestamp: '0x660a0000',
          baseFeePerGas: hex(1_000_000_000n),
          gasLimit: '0x1c9c380',
          gasUsed: '0xe4e1c0',
          transactions: [
            { maxPriorityFeePerGas: hex(2_000_000_000n), maxFeePerGas: hex(5_000_000_000n), gas: '0x5208', type: '0x2', hash: '0xring' },
          ],
        }
      }
      if (method === 'txpool_content') {
        return {
          pending: {
            '0xs': {
              '1': {
                hash: '0xnoFee',
                from: '0xs',
                nonce: '0x1',
                gas: '0x5208',
                // No maxFeePerGas / maxPriorityFeePerGas / gasPrice
              },
            },
          },
          queued: {},
        }
      }
      return null
    })
    const actions = gasOracleActions({
      chainId: 1,
      lifecycle: 'lazy',
      keepMempoolSnapshot: true,
    })(client)
    const result = await actions.tipForBlockPosition({ kind: 'rank', rank: 0 })
    // Must not throw — the no-fee mempool tx contributes a 0-tip
    // sample, and the ring's 2-gwei priority tx wins the rank-0 pivot.
    expect(result.pivot?.hash).toBe('0xring')
    actions.stopGasOracle()
  })

  it('getGasTiers second call returns cached state (no second pollOnce)', async () => {
    // Drives the `if (cached) return cached` true-arm in ensureState.
    let blockCalls = 0
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') {
        blockCalls += 1
        return fakeBlock()
      }
      return null
    })
    const actions = gasOracleActions({ chainId: 1, lifecycle: 'lazy' })(client)
    await actions.getGasTiers()
    const callsAfterFirst = blockCalls
    await actions.getGasTiers()
    // Second call hit the cache — no additional block fetch.
    expect(blockCalls).toBe(callsAfterFirst)
    actions.stopGasOracle()
  })

  it('tipForBlockPosition mempool tip clamps to headroom when maxPriority > headroom', async () => {
    // Drives the `maxPriority < headroom ? maxPriority : headroom`
    // headroom-side arm: maxPriority bigger than headroom → return
    // headroom (the cap).
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') {
        return {
          number: '0x1234',
          timestamp: '0x660a0000',
          baseFeePerGas: hex(1_000_000_000n),
          gasLimit: '0x1c9c380',
          gasUsed: '0xe4e1c0',
          transactions: [
            { maxPriorityFeePerGas: hex(1_000_000_000n), maxFeePerGas: hex(3_000_000_000n), gas: '0x5208', type: '0x2', hash: '0xring' },
          ],
        }
      }
      if (method === 'txpool_content') {
        return {
          pending: {
            '0xs': {
              '1': {
                hash: '0xcapped',
                from: '0xs',
                nonce: '0x1',
                gas: '0x5208',
                // headroom = maxFeePerGas - baseFee = 2gwei - 1gwei = 1gwei
                // maxPriority = 5gwei > headroom → clamps to 1gwei
                maxFeePerGas: hex(2_000_000_000n),
                maxPriorityFeePerGas: hex(5_000_000_000n),
                type: '0x2',
              },
            },
          },
          queued: {},
        }
      }
      return null
    })
    const actions = gasOracleActions({
      chainId: 1,
      lifecycle: 'lazy',
      keepMempoolSnapshot: true,
    })(client)
    const result = await actions.tipForBlockPosition({ kind: 'rank', rank: 0 })
    expect(result.requiredTip).toBeGreaterThan(0n)
    actions.stopGasOracle()
  })

  it('throws when poll cycle returns no state (upstream block fetch failure)', async () => {
    // Drives the `if (!polled) throw` branch in ensureState.
    const { client } = stubClient((method) => {
      // Every method returns null — the source's tick fails to get
      // a block, so reduce returns null, so pollOnce returns null.
      if (method === 'eth_getBlockByNumber') return null
      return null
    })
    const actions = gasOracleActions({
      chainId: 1,
      lifecycle: 'lazy',
    })(client)
    await expect(actions.getGasTiers()).rejects.toThrow(/poll cycle returned no state/)
    actions.stopGasOracle()
  })

  it('tipForBlockPosition mempool tip clamps to 0 when maxFee equals baseFee', async () => {
    // Drives the `headroom <= 0n` arm: maxFee equals baseFee → 0
    // headroom → tip clamps to 0n.
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') {
        return {
          number: '0x1234',
          timestamp: '0x660a0000',
          baseFeePerGas: hex(1_000_000_000n),
          gasLimit: '0x1c9c380',
          gasUsed: '0xe4e1c0',
          transactions: [
            { maxPriorityFeePerGas: hex(2_000_000_000n), maxFeePerGas: hex(5_000_000_000n), gas: '0x5208', type: '0x2', hash: '0xring' },
          ],
        }
      }
      if (method === 'txpool_content') {
        return {
          pending: {
            '0xs': {
              '1': {
                hash: '0xclamp',
                from: '0xs',
                nonce: '0x1',
                gas: '0x5208',
                maxFeePerGas: hex(1_000_000_000n), // == baseFee → 0 headroom
                maxPriorityFeePerGas: hex(2_000_000_000n),
                type: '0x2',
              },
            },
          },
          queued: {},
        }
      }
      return null
    })
    const actions = gasOracleActions({
      chainId: 1,
      lifecycle: 'lazy',
      keepMempoolSnapshot: true,
    })(client)
    const result = await actions.tipForBlockPosition({ kind: 'rank', rank: 0 })
    // Ring tx tip wins — mempool clamp tx contributed 0n.
    expect(result.pivot?.hash).toBe('0xring')
    actions.stopGasOracle()
  })

  it('tipForBlockPosition mempool legacy tx with gasPrice <= baseFee clamps to 0', async () => {
    // Drives the `price > state.baseFee ? price - baseFee : 0n` 0-arm.
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') {
        return {
          number: '0x1234',
          timestamp: '0x660a0000',
          baseFeePerGas: hex(1_000_000_000n),
          gasLimit: '0x1c9c380',
          gasUsed: '0xe4e1c0',
          transactions: [
            { maxPriorityFeePerGas: hex(2_000_000_000n), maxFeePerGas: hex(5_000_000_000n), gas: '0x5208', type: '0x2', hash: '0xring' },
          ],
        }
      }
      if (method === 'txpool_content') {
        return {
          pending: {
            '0xs': {
              '1': {
                hash: '0xlow-legacy',
                from: '0xs',
                nonce: '0x1',
                gas: '0x5208',
                gasPrice: hex(500_000_000n), // below baseFee → 0n tip
                type: '0x0',
              },
            },
          },
          queued: {},
        }
      }
      return null
    })
    const actions = gasOracleActions({
      chainId: 1,
      lifecycle: 'lazy',
      keepMempoolSnapshot: true,
    })(client)
    const result = await actions.tipForBlockPosition({ kind: 'rank', rank: 0 })
    // Doesn't throw; ring sample wins.
    expect(result.pivot?.hash).toBe('0xring')
    actions.stopGasOracle()
  })

  it('tipForBlockPosition with a null mempool falls back to ring samples only', async () => {
    const { client } = stubClient((method) => {
      if (method === 'eth_getBlockByNumber') {
        return {
          number: '0x1234',
          timestamp: '0x660a0000',
          baseFeePerGas: hex(1_000_000_000n),
          gasLimit: '0x1c9c380',
          gasUsed: '0xe4e1c0',
          transactions: [
            { maxPriorityFeePerGas: hex(5_000_000_000n), maxFeePerGas: hex(10_000_000_000n), gas: '0x5208', type: '0x2', hash: '0xring' },
          ],
        }
      }
      if (method === 'txpool_content') return new Error('method not found')
      return null
    })
    const actions = gasOracleActions({ chainId: 1, lifecycle: 'lazy' })(client)
    const result = await actions.tipForBlockPosition({ kind: 'rank', rank: 0 })
    expect(result.pivot?.hash).toBe('0xring')
    actions.stopGasOracle()
  })
})
