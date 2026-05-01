import { describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'

import { fetchOracleInputs } from './transport.js'

// Build a stand-in viem PublicClient that records every request and lets
// each test choose what to return per RPC method. We don't need any of the
// real viem machinery — only `client.request({ method, params })`.
const makeClient = (
  responder: (req: { method: string; params: unknown[] }) => unknown,
): { client: PublicClient; calls: { method: string; params: unknown[] }[] } => {
  const calls: { method: string; params: unknown[] }[] = []
  const request = vi.fn(async (req: { method: string; params: unknown[] }) => {
    calls.push(req)
    const result = responder(req)
    if (result instanceof Error) throw result
    return result
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { request } as unknown as PublicClient, calls }
}

const fakeBlock = {
  number: '0x1234',
  timestamp: '0x660a0000',
  baseFeePerGas: '0x3b9aca00',
  gasLimit: '0x1c9c380',
  gasUsed: '0xe4e1c0',
  transactions: [],
}

const fakeFeeHistory = {
  baseFeePerGas: ['0x3b9aca00'],
  reward: [['0x0', '0x0', '0x0', '0x0', '0x0']],
  gasUsedRatio: [0.5],
  oldestBlock: '0x100',
}

const fakeTxPool = {
  pending: { '0xabc': { '0': { gasPrice: '0x1', type: '0x0' } } },
  queued: {},
}

describe('fetchOracleInputs', () => {
  it('issues feeHistory + getBlockByNumber + txpool_content with the right args', async () => {
    const { client, calls } = makeClient(({ method }) => {
      if (method === 'eth_feeHistory') return fakeFeeHistory
      if (method === 'eth_getBlockByNumber') return fakeBlock
      if (method === 'txpool_content') return fakeTxPool
      return null
    })

    const result = await fetchOracleInputs(client)

    expect(result.feeHistory).toEqual(fakeFeeHistory)
    expect(result.block).toEqual(fakeBlock)
    expect(result.txPool).toEqual(fakeTxPool)

    const feeCall = calls.find((c) => c.method === 'eth_feeHistory')
    expect(feeCall?.params).toEqual(['0x14', 'latest', [10, 25, 50, 75, 90]])
    const blockCall = calls.find((c) => c.method === 'eth_getBlockByNumber')
    expect(blockCall?.params).toEqual(['latest', true])
    const poolCall = calls.find((c) => c.method === 'txpool_content')
    expect(poolCall?.params).toEqual([])
  })

  it('returns null for any sub-call that throws (siblings still resolve)', async () => {
    const { client } = makeClient(({ method }) => {
      if (method === 'txpool_content') return new Error('method not found')
      if (method === 'eth_feeHistory') return fakeFeeHistory
      if (method === 'eth_getBlockByNumber') return fakeBlock
      return null
    })

    const result = await fetchOracleInputs(client)

    expect(result.feeHistory).toEqual(fakeFeeHistory)
    expect(result.block).toEqual(fakeBlock)
    expect(result.txPool).toBeNull()
  })

  it('routes per-method failures through the onError callback', async () => {
    const { client } = makeClient(({ method }) => {
      if (method === 'txpool_content') return new Error('method not found')
      return method === 'eth_feeHistory' ? fakeFeeHistory : fakeBlock
    })
    const onError = vi.fn()

    await fetchOracleInputs(client, { onError })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBe('txpool_content')
    expect(onError.mock.calls[0][1]).toBeInstanceOf(Error)
  })

  it('returns nulls everywhere when the client itself rejects all calls', async () => {
    const { client } = makeClient(() => new Error('upstream down'))
    const result = await fetchOracleInputs(client)
    expect(result.feeHistory).toBeNull()
    expect(result.block).toBeNull()
    expect(result.txPool).toBeNull()
  })

  it('coerces an explicit null result to null (no thrown error)', async () => {
    // Some upstreams return `{ result: null }` instead of throwing.
    const { client } = makeClient(() => null)
    const result = await fetchOracleInputs(client)
    expect(result.feeHistory).toBeNull()
    expect(result.block).toBeNull()
    expect(result.txPool).toBeNull()
  })

  it('skips eth_feeHistory entirely when poll.feeHistory is false', async () => {
    const { client, calls } = makeClient(({ method }) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock
      if (method === 'txpool_content') return fakeTxPool
      return null
    })

    const result = await fetchOracleInputs(client, { poll: { feeHistory: false } })

    expect(result.feeHistory).toBeNull()
    expect(result.block).toEqual(fakeBlock)
    expect(result.txPool).toEqual(fakeTxPool)
    expect(calls.find((c) => c.method === 'eth_feeHistory')).toBeUndefined()
  })

  it('skips txpool_content entirely when poll.mempool is false', async () => {
    const { client, calls } = makeClient(({ method }) => {
      if (method === 'eth_feeHistory') return fakeFeeHistory
      if (method === 'eth_getBlockByNumber') return fakeBlock
      return null
    })

    const result = await fetchOracleInputs(client, { poll: { mempool: false } })

    expect(result.feeHistory).toEqual(fakeFeeHistory)
    expect(result.block).toEqual(fakeBlock)
    expect(result.txPool).toBeNull()
    expect(calls.find((c) => c.method === 'txpool_content')).toBeUndefined()
  })

  it('always issues eth_getBlockByNumber regardless of poll toggles', async () => {
    const { client, calls } = makeClient(({ method }) => {
      if (method === 'eth_getBlockByNumber') return fakeBlock
      return null
    })

    await fetchOracleInputs(client, { poll: { feeHistory: false, mempool: false } })

    const blockCall = calls.find((c) => c.method === 'eth_getBlockByNumber')
    expect(blockCall).toBeDefined()
    expect(calls).toHaveLength(1)
  })
})
