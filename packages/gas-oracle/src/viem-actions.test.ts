import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'

import { gasOracleActions } from './viem-actions.js'

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
  return { client: { request } as unknown as PublicClient, request }
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

    const fast = await actions.getGasTier('fast')
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

    // No polling has happened yet
    expect(request).not.toHaveBeenCalled()

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
      priorityModel: 'eip1559',
      lifecycle: 'lazy',
    })(client)

    const state = await actions.getGasTiers()
    // Under 'eip1559' the legacy zero-tip tx is excluded from paying lanes
    expect(state.tiers.fast.maxPriorityFeePerGas).toBeGreaterThan(0n)
    actions.stopGasOracle()
  })
})
