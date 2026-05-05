import { describe, it, expect, vi } from 'vitest'
import type { Hex } from 'viem'
import { sendTransactionWithHooks, WalletRejectedError } from './send.js'
import type { WalletAdapter, WalletSendTransactionRequest } from './wallet.js'

const REQUEST: WalletSendTransactionRequest = {
  to: '0x1111111111111111111111111111111111111111' as Hex,
  data: '0xdeadbeef' as Hex,
  chainId: 369,
}

const okWallet = (hash: Hex = '0xfeedface'): WalletAdapter => ({
  sendTransaction: vi.fn(async () => hash),
})

describe('sendTransactionWithHooks', () => {
  it('returns the hash from wallet.sendTransaction', async () => {
    const hash = await sendTransactionWithHooks({ wallet: okWallet('0xabc'), request: REQUEST })
    expect(hash).toBe('0xabc')
  })

  it('fires onAwaitingSignature immediately before wallet.sendTransaction', async () => {
    const order: string[] = []
    const wallet: WalletAdapter = {
      sendTransaction: vi.fn(async () => {
        order.push('sendTransaction')
        return '0xabc' as Hex
      }),
    }
    const hooks = { onAwaitingSignature: vi.fn(() => { order.push('onAwaitingSignature') }) }

    await sendTransactionWithHooks({ wallet, request: REQUEST, hooks })

    expect(order).toEqual(['onAwaitingSignature', 'sendTransaction'])
  })

  it('fires per-call onTransactionHash with the resolved hash', async () => {
    const onTransactionHash = vi.fn()
    await sendTransactionWithHooks({
      wallet: okWallet('0xabc'),
      request: REQUEST,
      hooks: { onTransactionHash },
    })
    expect(onTransactionHash).toHaveBeenCalledExactlyOnceWith('0xabc')
  })

  it('fires the global onTransactionHash with the resolved hash', async () => {
    const onTransactionHash = vi.fn()
    await sendTransactionWithHooks({
      wallet: okWallet('0xabc'),
      request: REQUEST,
      onTransactionHash,
    })
    expect(onTransactionHash).toHaveBeenCalledExactlyOnceWith('0xabc')
  })

  it('fires both global and per-call onTransactionHash on the same line', async () => {
    const order: string[] = []
    const global = vi.fn(() => { order.push('global') })
    const perCall = vi.fn(() => { order.push('perCall') })

    await sendTransactionWithHooks({
      wallet: okWallet('0xabc'),
      request: REQUEST,
      hooks: { onTransactionHash: perCall },
      onTransactionHash: global,
    })

    expect(global).toHaveBeenCalledWith('0xabc')
    expect(perCall).toHaveBeenCalledWith('0xabc')
    // Global fires first (analytics observers shouldn't be blocked behind UI state).
    expect(order).toEqual(['global', 'perCall'])
  })

  it('throws WalletRejectedError when wallet rejection is detected', async () => {
    const wallet: WalletAdapter = {
      sendTransaction: vi.fn(async () => {
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      }),
    }
    await expect(sendTransactionWithHooks({ wallet, request: REQUEST }))
      .rejects.toBeInstanceOf(WalletRejectedError)
  })

  it('preserves the original error as the cause of WalletRejectedError', async () => {
    const original = Object.assign(new Error('User denied transaction signature.'), { code: 4001 })
    const wallet: WalletAdapter = {
      sendTransaction: vi.fn(async () => { throw original }),
    }
    try {
      await sendTransactionWithHooks({ wallet, request: REQUEST })
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(WalletRejectedError)
      expect((err as WalletRejectedError).cause).toBe(original)
    }
  })

  it('does NOT fire onTransactionHash when wallet rejects', async () => {
    const onTransactionHash = vi.fn()
    const wallet: WalletAdapter = {
      sendTransaction: vi.fn(async () => {
        throw Object.assign(new Error('User rejected'), { code: 4001 })
      }),
    }
    await expect(
      sendTransactionWithHooks({
        wallet,
        request: REQUEST,
        hooks: { onTransactionHash },
        onTransactionHash,
      }),
    ).rejects.toThrow()
    expect(onTransactionHash).not.toHaveBeenCalled()
  })

  it('still fires onAwaitingSignature exactly once when wallet rejects', async () => {
    const onAwaitingSignature = vi.fn()
    const wallet: WalletAdapter = {
      sendTransaction: vi.fn(async () => {
        throw Object.assign(new Error('User rejected'), { code: 4001 })
      }),
    }
    await expect(
      sendTransactionWithHooks({ wallet, request: REQUEST, hooks: { onAwaitingSignature } }),
    ).rejects.toThrow()
    expect(onAwaitingSignature).toHaveBeenCalledOnce()
  })

  it('coerces a non-Error rejection (string thrown) into an Error cause', async () => {
    const wallet: WalletAdapter = {
      sendTransaction: vi.fn(async () => {
        throw 'User rejected the request'
      }),
    }
    try {
      await sendTransactionWithHooks({ wallet, request: REQUEST })
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(WalletRejectedError)
      const cause = (err as WalletRejectedError).cause
      expect(cause).toBeInstanceOf(Error)
      expect(cause.message).toBe('User rejected the request')
    }
  })

  it('re-throws non-rejection errors unchanged (consumer maps to its own error type)', async () => {
    const original = new Error('insufficient funds for gas')
    const wallet: WalletAdapter = {
      sendTransaction: vi.fn(async () => { throw original }),
    }
    await expect(sendTransactionWithHooks({ wallet, request: REQUEST }))
      .rejects.toBe(original)
  })

  it('works with no hooks and no global callback', async () => {
    await expect(sendTransactionWithHooks({ wallet: okWallet(), request: REQUEST }))
      .resolves.toBe('0xfeedface')
  })

  it('passes the full request through to wallet.sendTransaction unchanged', async () => {
    const send = vi.fn(async () => '0xabc' as Hex)
    const wallet: WalletAdapter = { sendTransaction: send }
    const request: WalletSendTransactionRequest = {
      to: '0x' as Hex,
      data: '0x' as Hex,
      value: 7n,
      chainId: 1,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 20n,
    }
    await sendTransactionWithHooks({ wallet, request })
    expect(send).toHaveBeenCalledExactlyOnceWith(request)
  })
})

describe('WalletRejectedError', () => {
  it('is an Error subclass with a stable name', () => {
    const e = new WalletRejectedError(new Error('inner'))
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(WalletRejectedError)
    expect(e.name).toBe('WalletRejectedError')
  })

  it('exposes the original error as `cause`', () => {
    const inner = new Error('User rejected')
    const e = new WalletRejectedError(inner)
    expect(e.cause).toBe(inner)
  })

  it('has a sensible default message', () => {
    expect(new WalletRejectedError(new Error('x')).message.length).toBeGreaterThan(0)
  })
})
