import { describe, it, expect, expectTypeOf } from 'vitest'
import type { Hex } from 'viem'
import type { WalletAdapter, WalletSendTransactionRequest } from './wallet.js'

describe('WalletAdapter contract', () => {
  it('a minimal adapter with sendTransaction satisfies the interface', () => {
    const adapter: WalletAdapter = {
      sendTransaction: async () => '0xabc' as Hex,
    }
    expect(adapter.address).toBeUndefined()
    expect(typeof adapter.sendTransaction).toBe('function')
  })

  it('readContract is optional', () => {
    const a: WalletAdapter = { sendTransaction: async () => '0xabc' as Hex }
    const b: WalletAdapter = {
      sendTransaction: async () => '0xabc' as Hex,
      readContract: async () => 0n,
    }
    expectTypeOf(a.readContract).toEqualTypeOf<WalletAdapter['readContract']>()
    expectTypeOf(b.readContract).toEqualTypeOf<WalletAdapter['readContract']>()
  })

  it('WalletSendTransactionRequest accepts EIP-1559 gas fields', () => {
    const req: WalletSendTransactionRequest = {
      to: '0x' as Hex,
      data: '0x' as Hex,
      value: 0n,
      chainId: 369,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 20n,
    }
    expect(req.chainId).toBe(369)
  })

  it('value, maxFeePerGas, maxPriorityFeePerGas are optional', () => {
    const req: WalletSendTransactionRequest = {
      to: '0x' as Hex,
      data: '0x' as Hex,
      chainId: 1,
    }
    expect(req.value).toBeUndefined()
    expect(req.maxFeePerGas).toBeUndefined()
  })
})
