import { describe, it, expect, vi } from 'vitest'
import type { Block, Hex, TransactionReceipt } from 'viem'
import { awaitReceiptWithHooks, ContractRevertedError, type ReceiptAwaiter } from './receipt.js'
import type { WalletSendTransactionRequest } from './wallet.js'

const HASH = '0xfeedface' as Hex

const REQUEST: WalletSendTransactionRequest = {
  to: '0x1111111111111111111111111111111111111111' as Hex,
  data: '0xdeadbeef' as Hex,
  chainId: 369,
}

const buildReceipt = (status: 'success' | 'reverted'): TransactionReceipt =>
  ({
    transactionHash: HASH,
    status,
    blockNumber: 1n,
    blockHash: '0xblock' as Hex,
    transactionIndex: 0,
    from: '0x' as Hex,
    to: '0x' as Hex,
    contractAddress: null,
    cumulativeGasUsed: 21000n,
    gasUsed: 21000n,
    effectiveGasPrice: 100n,
    logs: [],
    logsBloom: '0x',
    type: 'eip1559',
  }) as unknown as TransactionReceipt

const buildBlock = (): Block =>
  ({
    hash: '0xblock' as Hex,
    number: 1n,
    timestamp: 1700000000n,
    baseFeePerGas: 50n,
  }) as unknown as Block

const okClient = (status: 'success' | 'reverted'): ReceiptAwaiter => ({
  waitForTransactionReceipt: vi.fn(async () => buildReceipt(status)),
  getBlock: vi.fn(async () => buildBlock()),
})

describe('awaitReceiptWithHooks', () => {
  describe('on receipt success', () => {
    it('resolves with the receipt', async () => {
      const receipt = await awaitReceiptWithHooks({
        publicClient: okClient('success'),
        hash: HASH,
        request: REQUEST,
      })
      expect(receipt.status).toBe('success')
      expect(receipt.transactionHash).toBe(HASH)
    })

    it('fetches the block by blockHash and includes it in onConfirmed payload', async () => {
      const getBlock = vi.fn(async () => buildBlock())
      const publicClient: ReceiptAwaiter = {
        waitForTransactionReceipt: vi.fn(async () => buildReceipt('success')),
        getBlock,
      }
      const onConfirmed = vi.fn()
      await awaitReceiptWithHooks({
        publicClient,
        hash: HASH,
        request: REQUEST,
        hooks: { onConfirmed },
      })
      expect(getBlock).toHaveBeenCalledExactlyOnceWith({ blockHash: '0xblock' })
      expect(onConfirmed).toHaveBeenCalledOnce()
      const [info] = onConfirmed.mock.calls[0]!
      expect(info.chainId).toBe(369)
      expect(info.request).toBe(REQUEST)
      expect(info.hash).toBe(HASH)
      expect(info.receipt.status).toBe('success')
      expect(info.block).toMatchObject({ number: 1n, timestamp: 1700000000n })
    })

    it("fires onPhase('confirmed') with chainId + request + hash + receipt + block", async () => {
      const onPhase = vi.fn()
      await awaitReceiptWithHooks({
        publicClient: okClient('success'),
        hash: HASH,
        request: REQUEST,
        hooks: { onPhase },
      })
      expect(onPhase).toHaveBeenCalledOnce()
      const [event] = onPhase.mock.calls[0]!
      expect(event).toMatchObject({
        phase: 'confirmed',
        hash: HASH,
        chainId: 369,
        request: REQUEST,
      })
      expect(event.receipt.status).toBe('success')
      expect(event.block).toMatchObject({ number: 1n, timestamp: 1700000000n })
    })

    it('does NOT fetch the block when includeBlock: false', async () => {
      const getBlock = vi.fn(async () => buildBlock())
      const publicClient: ReceiptAwaiter = {
        waitForTransactionReceipt: vi.fn(async () => buildReceipt('success')),
        getBlock,
      }
      const onConfirmed = vi.fn()
      await awaitReceiptWithHooks({
        publicClient,
        hash: HASH,
        request: REQUEST,
        includeBlock: false,
        hooks: { onConfirmed },
      })
      expect(getBlock).not.toHaveBeenCalled()
      expect(onConfirmed).toHaveBeenCalledOnce()
      const [info] = onConfirmed.mock.calls[0]!
      expect(info.block).toBeUndefined()
      expect(info.chainId).toBe(369)
      expect(info.request).toBe(REQUEST)
      expect(info.receipt.status).toBe('success')
    })

    it('does NOT fire onFailed on success', async () => {
      const onFailed = vi.fn()
      await awaitReceiptWithHooks({
        publicClient: okClient('success'),
        hash: HASH,
        request: REQUEST,
        hooks: { onFailed },
      })
      expect(onFailed).not.toHaveBeenCalled()
    })
  })

  describe('on receipt revert', () => {
    it('throws ContractRevertedError', async () => {
      await expect(
        awaitReceiptWithHooks({ publicClient: okClient('reverted'), hash: HASH, request: REQUEST }),
      ).rejects.toBeInstanceOf(ContractRevertedError)
    })

    it('attaches hash and full receipt to ContractRevertedError', async () => {
      try {
        await awaitReceiptWithHooks({ publicClient: okClient('reverted'), hash: HASH, request: REQUEST })
        expect.fail('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(ContractRevertedError)
        const e = err as ContractRevertedError
        expect(e.hash).toBe(HASH)
        expect(e.receipt.status).toBe('reverted')
      }
    })

    it('fires onFailed with TxContext + ContractRevertedError + hash + receipt + block', async () => {
      const onFailed = vi.fn()
      await expect(
        awaitReceiptWithHooks({
          publicClient: okClient('reverted'),
          hash: HASH,
          request: REQUEST,
          hooks: { onFailed },
        }),
      ).rejects.toThrow()
      expect(onFailed).toHaveBeenCalledOnce()
      const [info] = onFailed.mock.calls[0]!
      expect(info.error).toBeInstanceOf(ContractRevertedError)
      expect(info.chainId).toBe(369)
      expect(info.request).toBe(REQUEST)
      expect(info.hash).toBe(HASH)
      expect(info.receipt.status).toBe('reverted')
      expect(info.block).toMatchObject({ number: 1n })
    })

    it("fires onPhase('failed') with chainId + request + hash + receipt + block + error", async () => {
      const onPhase = vi.fn()
      await expect(
        awaitReceiptWithHooks({
          publicClient: okClient('reverted'),
          hash: HASH,
          request: REQUEST,
          hooks: { onPhase },
        }),
      ).rejects.toThrow()
      expect(onPhase).toHaveBeenCalledOnce()
      const [event] = onPhase.mock.calls[0]!
      expect(event).toMatchObject({
        phase: 'failed',
        hash: HASH,
        chainId: 369,
        request: REQUEST,
      })
      expect(event.error).toBeInstanceOf(ContractRevertedError)
      expect(event.receipt.status).toBe('reverted')
      expect(event.block).toMatchObject({ number: 1n })
    })

    it('does NOT fetch the block on revert when includeBlock: false', async () => {
      const getBlock = vi.fn(async () => buildBlock())
      const publicClient: ReceiptAwaiter = {
        waitForTransactionReceipt: vi.fn(async () => buildReceipt('reverted')),
        getBlock,
      }
      const onFailed = vi.fn()
      await expect(
        awaitReceiptWithHooks({
          publicClient,
          hash: HASH,
          request: REQUEST,
          includeBlock: false,
          hooks: { onFailed },
        }),
      ).rejects.toThrow()
      expect(getBlock).not.toHaveBeenCalled()
      const [info] = onFailed.mock.calls[0]!
      expect(info.block).toBeUndefined()
      expect(info.receipt.status).toBe('reverted')
    })

    it('does NOT fire onConfirmed on revert', async () => {
      const onConfirmed = vi.fn()
      await expect(
        awaitReceiptWithHooks({
          publicClient: okClient('reverted'),
          hash: HASH,
          request: REQUEST,
          hooks: { onConfirmed },
        }),
      ).rejects.toThrow()
      expect(onConfirmed).not.toHaveBeenCalled()
    })
  })

  describe('on receipt-await error (network / timeout)', () => {
    it('fires onFailed with TxContext + the original error and rethrows it unchanged', async () => {
      const original = new Error('RPC timeout')
      const onFailed = vi.fn()
      const publicClient: ReceiptAwaiter = {
        waitForTransactionReceipt: vi.fn(async () => { throw original }),
        getBlock: vi.fn(async () => buildBlock()),
      }
      await expect(
        awaitReceiptWithHooks({ publicClient, hash: HASH, request: REQUEST, hooks: { onFailed } }),
      ).rejects.toBe(original)
      expect(onFailed).toHaveBeenCalledOnce()
      const [info] = onFailed.mock.calls[0]!
      expect(info.error).toBe(original)
      expect(info.chainId).toBe(369)
      expect(info.request).toBe(REQUEST)
      expect(info.hash).toBeUndefined()
      expect(info.receipt).toBeUndefined()
      expect(info.block).toBeUndefined()
    })

    it('does NOT call getBlock when waitForTransactionReceipt itself fails', async () => {
      const getBlock = vi.fn(async () => buildBlock())
      const publicClient: ReceiptAwaiter = {
        waitForTransactionReceipt: vi.fn(async () => { throw new Error('RPC timeout') }),
        getBlock,
      }
      await expect(
        awaitReceiptWithHooks({ publicClient, hash: HASH, request: REQUEST }),
      ).rejects.toThrow()
      expect(getBlock).not.toHaveBeenCalled()
    })

    it('coerces a thrown non-Error into an Error before firing onFailed', async () => {
      const onFailed = vi.fn()
      const publicClient: ReceiptAwaiter = {
        waitForTransactionReceipt: vi.fn(async () => { throw 'something broke' }),
        getBlock: vi.fn(async () => buildBlock()),
      }
      try {
        await awaitReceiptWithHooks({ publicClient, hash: HASH, request: REQUEST, hooks: { onFailed } })
        expect.fail('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).message).toBe('something broke')
      }
      expect(onFailed).toHaveBeenCalledOnce()
      const [info] = onFailed.mock.calls[0]!
      expect(info.error).toBeInstanceOf(Error)
    })
  })

  describe('with no hooks', () => {
    it('resolves on success without throwing', async () => {
      const receipt = await awaitReceiptWithHooks({
        publicClient: okClient('success'),
        hash: HASH,
        request: REQUEST,
      })
      expect(receipt.status).toBe('success')
    })

    it('still throws ContractRevertedError on revert', async () => {
      await expect(
        awaitReceiptWithHooks({ publicClient: okClient('reverted'), hash: HASH, request: REQUEST }),
      ).rejects.toBeInstanceOf(ContractRevertedError)
    })

    it('still fetches the block on success (default includeBlock: true)', async () => {
      const getBlock = vi.fn(async () => buildBlock())
      const publicClient: ReceiptAwaiter = {
        waitForTransactionReceipt: vi.fn(async () => buildReceipt('success')),
        getBlock,
      }
      await awaitReceiptWithHooks({ publicClient, hash: HASH, request: REQUEST })
      expect(getBlock).toHaveBeenCalledExactlyOnceWith({ blockHash: '0xblock' })
    })
  })
})

describe('ContractRevertedError', () => {
  it('is an Error subclass with stable name', () => {
    const e = new ContractRevertedError(HASH, buildReceipt('reverted'))
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(ContractRevertedError)
    expect(e.name).toBe('ContractRevertedError')
  })

  it('exposes hash and receipt as readonly fields', () => {
    const receipt = buildReceipt('reverted')
    const e = new ContractRevertedError(HASH, receipt)
    expect(e.hash).toBe(HASH)
    expect(e.receipt).toBe(receipt)
  })

  it('has a sensible default message', () => {
    expect(new ContractRevertedError(HASH, buildReceipt('reverted')).message.length)
      .toBeGreaterThan(0)
  })
})
