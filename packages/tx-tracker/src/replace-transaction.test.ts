import { test, expect, vi } from 'vitest'

import { replaceTransaction } from './replace-transaction.js'

test('replaceTransaction — sends a same-nonce write with bumped gas', async () => {
  const sendTransaction = vi.fn(async (_req: unknown) => '0xnewhash' as const)
  const walletClient = {
    account: { address: '0xacct' },
    sendTransaction,
  } as never

  const result = await replaceTransaction({
    original: {
      to: '0xrecipient',
      nonce: 42,
      data: '0xdeadbeef',
      value: 100n,
    },
    walletClient,
    newGas: {
      maxFeePerGas: 1100000000n,
      maxPriorityFeePerGas: 110000000n,
    },
  })

  expect(result).toBe('0xnewhash')
  expect(sendTransaction).toHaveBeenCalledOnce()
  const req = sendTransaction.mock.calls[0]?.[0] as {
    to: string
    nonce: number
    data?: string
    value?: bigint
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
  }
  expect(req.nonce).toBe(42)
  expect(req.to).toBe('0xrecipient')
  expect(req.data).toBe('0xdeadbeef')
  expect(req.value).toBe(100n)
  expect(req.maxFeePerGas).toBe(1100000000n)
  expect(req.maxPriorityFeePerGas).toBe(110000000n)
})

test('replaceTransaction — throws when walletClient has no account', async () => {
  await expect(
    replaceTransaction({
      original: { to: '0xr', nonce: 1 },
      walletClient: { account: null, sendTransaction: vi.fn() } as never,
      newGas: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    }),
  ).rejects.toThrow(/must have an account/)
})

test('replaceTransaction — propagates walletClient errors', async () => {
  const walletClient = {
    account: { address: '0xa' },
    sendTransaction: vi.fn(async (_req: unknown) => {
      throw new Error('user rejected')
    }),
  } as never
  await expect(
    replaceTransaction({
      original: { to: '0xr', nonce: 1 },
      walletClient,
      newGas: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    }),
  ).rejects.toThrow(/user rejected/)
})

test('replaceTransaction — handles original without data and value', async () => {
  const sendTransaction = vi.fn(async (_req: unknown) => '0xh' as const)
  const walletClient = {
    account: { address: '0xa' },
    sendTransaction,
  } as never
  await replaceTransaction({
    original: { to: '0xr', nonce: 5 },
    walletClient,
    newGas: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
  })
  const req = sendTransaction.mock.calls[0]?.[0] as {
    data?: string
    value?: bigint
  }
  expect(req.data).toBeUndefined()
  expect(req.value).toBeUndefined()
})

test('replaceTransaction — passes account from walletClient', async () => {
  const sendTransaction = vi.fn(async (_req: unknown) => '0xhash' as const)
  const account = { address: '0xabcdef' }
  const walletClient = { account, sendTransaction } as never

  await replaceTransaction({
    original: { to: '0xr', nonce: 7 },
    walletClient,
    newGas: { maxFeePerGas: 5n, maxPriorityFeePerGas: 2n },
  })

  const req = sendTransaction.mock.calls[0]?.[0] as { account: unknown }
  expect(req.account).toBe(account)
})

test('replaceTransaction — chain is null in the request', async () => {
  const sendTransaction = vi.fn(async (_req: unknown) => '0xhash' as const)
  const walletClient = {
    account: { address: '0xa' },
    sendTransaction,
  } as never

  await replaceTransaction({
    original: { to: '0xr', nonce: 3 },
    walletClient,
    newGas: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
  })

  const req = sendTransaction.mock.calls[0]?.[0] as { chain: unknown }
  expect(req.chain).toBeNull()
})
