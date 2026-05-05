import { test, expect, vi } from 'vitest'
import type { PublicClient } from 'viem'

import {
  safeRequest,
  fetchHeadBlockNumber,
  fetchBlock,
  fetchFeeHistory,
  fetchTxPool,
  fetchReceipt,
  fetchTransaction,
  zeroHash,
} from './transport.js'
import type { BlockResult, FeeHistoryResult, RawTx, TxPoolContent } from './types.js'

interface RpcCall {
  method: string
  params: unknown[]
}

const stubClient = (
  responder: (call: RpcCall) => unknown,
): { client: PublicClient; calls: RpcCall[] } => {
  const calls: RpcCall[] = []
  const client = {
    request: vi.fn(async ({ method, params }: RpcCall) => {
      calls.push({ method, params })
      return responder({ method, params })
    }),
  } as unknown as PublicClient
  return { client, calls }
}

test('safeRequest returns the upstream value on success', async () => {
  const { client } = stubClient(() => '0x42')
  const result = await safeRequest<string>(client, 'eth_blockNumber', [])
  expect(result).toBe('0x42')
})

test('safeRequest returns null when the upstream throws', async () => {
  const { client } = stubClient(() => {
    throw new Error('method not found')
  })
  const onError = vi.fn()
  const result = await safeRequest<string>(client, 'txpool_content', [], onError)
  expect(result).toBeNull()
  expect(onError).toHaveBeenCalledTimes(1)
  expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error)
})

test('safeRequest treats undefined upstream values as null', async () => {
  // Some providers return `undefined` (or null) for unknown methods
  // instead of throwing. Either is "no answer" — collapse both to null
  // so callers' `null`-checks cover both shapes.
  const { client } = stubClient(() => undefined)
  const result = await safeRequest<string>(client, 'txpool_content', [])
  expect(result).toBeNull()
})

test('fetchHeadBlockNumber decodes the hex head into a bigint', async () => {
  const { client, calls } = stubClient(() => '0x10')
  const head = await fetchHeadBlockNumber(client)
  expect(head).toBe(16n)
  expect(calls).toEqual([{ method: 'eth_blockNumber', params: [] }])
})

test('fetchHeadBlockNumber returns null when the upstream returns null', async () => {
  const { client } = stubClient(() => {
    throw new Error('rpc dead')
  })
  const head = await fetchHeadBlockNumber(client)
  expect(head).toBeNull()
})

test('fetchBlock encodes "latest" and asks for full transactions', async () => {
  const block: BlockResult = {
    number: '0x10',
    timestamp: '0x1',
    baseFeePerGas: '0x7',
    gasLimit: '0x5208',
    gasUsed: '0x0',
    transactions: [],
  }
  const { client, calls } = stubClient(() => block)
  const result = await fetchBlock(client, 'latest')
  expect(result).toBe(block)
  expect(calls).toEqual([
    { method: 'eth_getBlockByNumber', params: ['latest', true] },
  ])
})

test('fetchBlock encodes a bigint block number as a hex tag', async () => {
  const { client, calls } = stubClient(() => null)
  await fetchBlock(client, 12345n)
  expect(calls).toEqual([
    { method: 'eth_getBlockByNumber', params: ['0x3039', true] },
  ])
})

test('fetchBlock returns null when the upstream throws', async () => {
  const { client } = stubClient(() => {
    throw new Error('upstream error')
  })
  const onError = vi.fn()
  const result = await fetchBlock(client, 'latest', onError)
  expect(result).toBeNull()
  expect(onError).toHaveBeenCalledTimes(1)
})

test('fetchFeeHistory passes blockCount and percentiles correctly', async () => {
  const fixture: FeeHistoryResult = {
    baseFeePerGas: ['0x1', '0x2'],
    gasUsedRatio: [0.5],
    oldestBlock: '0x0',
  }
  const { client, calls } = stubClient(() => fixture)
  const result = await fetchFeeHistory(client, 20, [10, 25, 50, 75, 90])
  expect(result).toBe(fixture)
  expect(calls).toEqual([
    { method: 'eth_feeHistory', params: ['0x14', 'latest', [10, 25, 50, 75, 90]] },
  ])
})

test('fetchTxPool returns the raw TxPoolContent on success', async () => {
  const fixture: TxPoolContent = {
    pending: { '0xabc': { '5': { hash: '0xdef' } } },
    queued: {},
  }
  const { client, calls } = stubClient(() => fixture)
  const result = await fetchTxPool(client)
  expect(result).toBe(fixture)
  expect(calls).toEqual([{ method: 'txpool_content', params: [] }])
})

test('fetchTxPool returns null when the method is gated', async () => {
  const { client } = stubClient(() => {
    throw new Error('Method txpool_content not available')
  })
  const onError = vi.fn()
  const result = await fetchTxPool(client, onError)
  expect(result).toBeNull()
  expect(onError).toHaveBeenCalledTimes(1)
})

test('fetchReceipt forwards the hash and returns the receipt', async () => {
  const hash = '0xabc'
  const receipt = { transactionHash: hash, blockHash: '0x111', blockNumber: '0xa' }
  const { client, calls } = stubClient(() => receipt)
  const result = await fetchReceipt(client, hash)
  expect(result).toEqual(receipt)
  expect(calls).toEqual([{ method: 'eth_getTransactionReceipt', params: [hash] }])
})

test('fetchReceipt returns null when no receipt exists', async () => {
  const { client } = stubClient(() => null)
  const result = await fetchReceipt(client, '0x' + '00'.repeat(32))
  expect(result).toBeNull()
})

test('fetchTransaction forwards the hash and returns the RawTx', async () => {
  const hash = '0xabc'
  const tx: RawTx = { hash, from: '0x123', nonce: '0x5', gasPrice: '0x1' }
  const { client, calls } = stubClient(() => tx)
  const result = await fetchTransaction(client, hash)
  expect(result).toBe(tx)
  expect(calls).toEqual([{ method: 'eth_getTransactionByHash', params: [hash] }])
})

test('zeroHash is the canonical 32-byte zero', () => {
  expect(zeroHash).toBe('0x' + '00'.repeat(32))
})
