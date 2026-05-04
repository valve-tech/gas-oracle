import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from 'viem'

import { withGasOracle } from './viem-transport.js'

const hex = (n: bigint) => '0x' + n.toString(16)

const fakeBlock = () => ({
  number: '0x1234',
  timestamp: '0x660a0000',
  baseFeePerGas: hex(1_000_000_000n),
  gasLimit: '0x1c9c380',
  gasUsed: '0xe4e1c0',
  transactions: [
    { maxPriorityFeePerGas: hex(1_000_000_000n), maxFeePerGas: hex(3_000_000_000n), gas: '0x5208', type: '0x2' },
    { maxPriorityFeePerGas: hex(2_000_000_000n), maxFeePerGas: hex(5_000_000_000n), gas: '0x5208', type: '0x2' },
  ],
})

/**
 * Build a fake Transport that records every request method and serves
 * canned responses. Returns the Transport, plus the `calls` log so
 * tests can assert which methods were forwarded vs. intercepted.
 */
const fakeTransport = (
  responder: (method: string) => unknown,
): { transport: Transport; calls: string[] } => {
  const calls: string[] = []
  // viem's Transport is a factory; the inner instance just needs `request`.
  const transport: Transport = (() =>
    ({
      config: {
        key: 'fake',
        name: 'Fake Transport',
        type: 'fake',
        retryCount: 0,
        retryDelay: 0,
        timeout: 0,
        request: async () => undefined,
      },
      request: async (req: { method: string; params?: unknown[] }) => {
        calls.push(req.method)
        const result = responder(req.method)
        if (result instanceof Error) throw result
        return result
      },
      value: undefined,
    } as never)) as Transport
  return { transport, calls }
}

describe('withGasOracle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('intercepts eth_gasFeeEstimate by default and returns a structured tier shape', async () => {
    const { transport } = fakeTransport((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      return null
    })
    const wrapped = withGasOracle(transport, { chainId: 1, lifecycle: 'lazy' })
    const instance = wrapped({})

    const result = (await instance.request({
      method: 'eth_gasFeeEstimate',
      params: [],
    } as never)) as { baseFee: string; tiers: Record<string, Record<string, string>> }

    expect(result.baseFee).toBe(hex(1_000_000_000n))
    expect(result.tiers).toHaveProperty('slow')
    expect(result.tiers).toHaveProperty('standard')
    expect(result.tiers).toHaveProperty('fast')
    expect(result.tiers).toHaveProperty('instant')
    wrapped.stopGasOracle()
  })

  it('passes through eth_gasPrice when not opted in', async () => {
    const { transport, calls } = fakeTransport((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      if (method === 'eth_gasPrice') return '0xdeadbeef'
      return null
    })
    const wrapped = withGasOracle(transport, { chainId: 1, lifecycle: 'lazy' })
    const instance = wrapped({})

    const result = await instance.request({ method: 'eth_gasPrice' } as never)
    expect(result).toBe('0xdeadbeef')
    expect(calls).toContain('eth_gasPrice')
    wrapped.stopGasOracle()
  })

  it('intercepts eth_gasPrice when opted in with a tier', async () => {
    const { transport, calls } = fakeTransport((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      if (method === 'eth_gasPrice') return '0xdeadbeef'
      return null
    })
    const wrapped = withGasOracle(transport, {
      chainId: 1,
      lifecycle: 'lazy',
      intercept: { eth_gasPrice: 'fast' },
    })
    const instance = wrapped({})

    const result = await instance.request({ method: 'eth_gasPrice' } as never)
    expect(result).not.toBe('0xdeadbeef')
    expect(typeof result).toBe('string')
    expect((result as string).startsWith('0x')).toBe(true)
    // Should NOT have forwarded eth_gasPrice upstream
    expect(calls).not.toContain('eth_gasPrice')
    wrapped.stopGasOracle()
  })

  it('intercepts eth_maxPriorityFeePerGas when opted in with a tier', async () => {
    const { transport, calls } = fakeTransport((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      return null
    })
    const wrapped = withGasOracle(transport, {
      chainId: 1,
      lifecycle: 'lazy',
      intercept: { eth_maxPriorityFeePerGas: 'fast' },
    })
    const instance = wrapped({})

    const result = await instance.request({
      method: 'eth_maxPriorityFeePerGas',
    } as never)
    expect(typeof result).toBe('string')
    expect((result as string).startsWith('0x')).toBe(true)
    expect(calls).not.toContain('eth_maxPriorityFeePerGas')
    wrapped.stopGasOracle()
  })

  it('passes through eth_feeHistory regardless of intercept config (deliberate v0.2 omission)', async () => {
    const upstreamFeeHistory = {
      baseFeePerGas: ['0x1', '0x2'],
      reward: [['0x0']],
      gasUsedRatio: [0.5],
      oldestBlock: '0x100',
    }
    const { transport, calls } = fakeTransport((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      if (method === 'eth_feeHistory') return upstreamFeeHistory
      return null
    })
    const wrapped = withGasOracle(transport, {
      chainId: 1,
      lifecycle: 'lazy',
      // even an explicit attempt at "intercept everything" must not eat fee history
      intercept: { eth_gasPrice: 'fast', eth_maxPriorityFeePerGas: 'fast' },
    })
    const instance = wrapped({})

    const result = await instance.request({
      method: 'eth_feeHistory',
      params: ['0x14', 'latest', [10, 50, 90]],
    } as never)
    expect(result).toEqual(upstreamFeeHistory)
    // Accept either: the call could appear once (passthrough on read) and
    // separately for the oracle's own poll. The contract is "the caller's
    // request reached upstream and they got upstream's answer."
    expect(calls.filter((c) => c === 'eth_feeHistory').length).toBeGreaterThanOrEqual(1)
    wrapped.stopGasOracle()
  })

  it('falls back to passthrough when oracle has no state and cold-start poll fails', async () => {
    const { transport } = fakeTransport((method) => {
      if (method === 'eth_getBlockByNumber') return new Error('rpc down')
      if (method === 'eth_gasPrice') return '0xfeed'
      return null
    })
    const wrapped = withGasOracle(transport, {
      chainId: 1,
      lifecycle: 'lazy',
      intercept: { eth_gasPrice: 'fast' },
    })
    const instance = wrapped({})

    // No oracle state available → upstream answer comes through
    const result = await instance.request({ method: 'eth_gasPrice' } as never)
    expect(result).toBe('0xfeed')
    wrapped.stopGasOracle()
  })

  it('disables eth_gasFeeEstimate intercept when explicitly set to false', async () => {
    const upstreamEstimate = { upstream: 'value' }
    const { transport } = fakeTransport((method) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock()
      if (method === 'eth_gasFeeEstimate') return upstreamEstimate
      return null
    })
    const wrapped = withGasOracle(transport, {
      chainId: 1,
      lifecycle: 'lazy',
      intercept: { eth_gasFeeEstimate: false },
    })
    const instance = wrapped({})

    const result = await instance.request({
      method: 'eth_gasFeeEstimate',
      params: [],
    } as never)
    expect(result).toEqual(upstreamEstimate)
    wrapped.stopGasOracle()
  })

  it('exposes stopGasOracle for shutdown', () => {
    const { transport } = fakeTransport(() => null)
    const wrapped = withGasOracle(transport, { chainId: 1, lifecycle: 'lazy' })
    expect(typeof wrapped.stopGasOracle).toBe('function')
    expect(() => wrapped.stopGasOracle()).not.toThrow()
    // Idempotent
    expect(() => wrapped.stopGasOracle()).not.toThrow()
  })
})
