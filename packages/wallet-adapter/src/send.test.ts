import { describe, it, expect, vi } from 'vitest'
import type { Hex } from 'viem'
import { sendTransactionWithHooks, WalletRejectedError } from './send.js'
import type { WalletAdapter, WalletSendTransactionRequest } from './wallet.js'
import type { WritePhaseEvent } from './hooks.js'

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

  it('fires onAwaitingSignature with TxContext (chainId + request) before sendTransaction', async () => {
    const order: string[] = []
    const wallet: WalletAdapter = {
      sendTransaction: vi.fn(async () => {
        order.push('sendTransaction')
        return '0xabc' as Hex
      }),
    }
    const onAwaitingSignature = vi.fn(() => { order.push('onAwaitingSignature') })

    await sendTransactionWithHooks({ wallet, request: REQUEST, hooks: { onAwaitingSignature } })

    expect(order).toEqual(['onAwaitingSignature', 'sendTransaction'])
    expect(onAwaitingSignature).toHaveBeenCalledExactlyOnceWith({
      chainId: 369,
      request: REQUEST,
    })
  })

  it('fires per-call onTransactionHash with TxContext + hash', async () => {
    const onTransactionHash = vi.fn()
    await sendTransactionWithHooks({
      wallet: okWallet('0xabc'),
      request: REQUEST,
      hooks: { onTransactionHash },
    })
    expect(onTransactionHash).toHaveBeenCalledExactlyOnceWith({
      chainId: 369,
      request: REQUEST,
      hash: '0xabc',
    })
  })

  it('fires the global onTransactionHash with TxContext + hash', async () => {
    const onTransactionHash = vi.fn()
    await sendTransactionWithHooks({
      wallet: okWallet('0xabc'),
      request: REQUEST,
      onTransactionHash,
    })
    expect(onTransactionHash).toHaveBeenCalledExactlyOnceWith({
      chainId: 369,
      request: REQUEST,
      hash: '0xabc',
    })
  })

  it('fires both global and per-call onTransactionHash on the same line, with rich payload', async () => {
    const order: string[] = []
    const global = vi.fn(() => { order.push('global') })
    const perCall = vi.fn(() => { order.push('perCall') })

    await sendTransactionWithHooks({
      wallet: okWallet('0xabc'),
      request: REQUEST,
      hooks: { onTransactionHash: perCall },
      onTransactionHash: global,
    })

    const expectedInfo = { chainId: 369, request: REQUEST, hash: '0xabc' }
    expect(global).toHaveBeenCalledWith(expectedInfo)
    expect(perCall).toHaveBeenCalledWith(expectedInfo)
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

  it('fires onFailed with TxContext + WalletRejectedError when the wallet rejects', async () => {
    const onFailed = vi.fn()
    const wallet: WalletAdapter = {
      sendTransaction: vi.fn(async () => {
        throw Object.assign(new Error('User rejected'), { code: 4001 })
      }),
    }
    await expect(
      sendTransactionWithHooks({ wallet, request: REQUEST, hooks: { onFailed } }),
    ).rejects.toBeInstanceOf(WalletRejectedError)
    expect(onFailed).toHaveBeenCalledOnce()
    const [info] = onFailed.mock.calls[0]!
    expect(info.error).toBeInstanceOf(WalletRejectedError)
    expect(info.chainId).toBe(369)
    expect(info.request).toBe(REQUEST)
    expect(info.hash).toBeUndefined()
    expect(info.receipt).toBeUndefined()
  })

  it('fires onFailed with TxContext + the original Error when a non-rejection error is thrown', async () => {
    const original = new Error('insufficient funds for gas')
    const onFailed = vi.fn()
    const wallet: WalletAdapter = {
      sendTransaction: vi.fn(async () => { throw original }),
    }
    await expect(
      sendTransactionWithHooks({ wallet, request: REQUEST, hooks: { onFailed } }),
    ).rejects.toBe(original)
    expect(onFailed).toHaveBeenCalledOnce()
    const [info] = onFailed.mock.calls[0]!
    expect(info.error).toBe(original)
    expect(info.chainId).toBe(369)
    expect(info.request).toBe(REQUEST)
  })

  it('coerces a thrown non-Error non-rejection into an Error before firing onFailed', async () => {
    const onFailed = vi.fn()
    const wallet: WalletAdapter = {
      sendTransaction: vi.fn(async () => { throw 'something exploded' }),
    }
    try {
      await sendTransactionWithHooks({ wallet, request: REQUEST, hooks: { onFailed } })
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toBe('something exploded')
    }
    expect(onFailed).toHaveBeenCalledOnce()
    const [info] = onFailed.mock.calls[0]!
    expect(info.error).toBeInstanceOf(Error)
  })

  it('does NOT fire onFailed on success', async () => {
    const onFailed = vi.fn()
    await sendTransactionWithHooks({
      wallet: okWallet(),
      request: REQUEST,
      hooks: { onFailed },
    })
    expect(onFailed).not.toHaveBeenCalled()
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

  describe('onPhase (single-callback shape)', () => {
    it("fires phase='awaiting-signature' with chainId+request, then phase='pending' with chainId+request+hash", async () => {
      const events: WritePhaseEvent[] = []
      await sendTransactionWithHooks({
        wallet: okWallet('0xabc'),
        request: REQUEST,
        hooks: { onPhase: (e: WritePhaseEvent) => { events.push(e) } },
      })
      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({
        phase: 'awaiting-signature',
        chainId: 369,
        request: REQUEST,
      })
      expect(events[1]).toEqual({
        phase: 'pending',
        chainId: 369,
        request: REQUEST,
        hash: '0xabc',
      })
    })

    it("fires phase='failed' with TxContext + WalletRejectedError when wallet rejects", async () => {
      const onPhase = vi.fn()
      const wallet: WalletAdapter = {
        sendTransaction: vi.fn(async () => {
          throw Object.assign(new Error('User rejected'), { code: 4001 })
        }),
      }
      await expect(
        sendTransactionWithHooks({ wallet, request: REQUEST, hooks: { onPhase } }),
      ).rejects.toBeInstanceOf(WalletRejectedError)

      expect(onPhase).toHaveBeenCalledTimes(2)
      const second = onPhase.mock.calls[1]![0] as Extract<WritePhaseEvent, { phase: 'failed' }>
      expect(second.phase).toBe('failed')
      expect(second.error).toBeInstanceOf(WalletRejectedError)
      expect(second.chainId).toBe(369)
      expect(second.request).toBe(REQUEST)
    })

    it('fires both onPhase and the matching named hook on each transition with the same payload shape', async () => {
      const onAwaitingSignature = vi.fn()
      const onTransactionHash = vi.fn()
      const onPhase = vi.fn()
      await sendTransactionWithHooks({
        wallet: okWallet('0xabc'),
        request: REQUEST,
        hooks: { onAwaitingSignature, onTransactionHash, onPhase },
      })
      expect(onAwaitingSignature).toHaveBeenCalledExactlyOnceWith({
        chainId: 369,
        request: REQUEST,
      })
      expect(onTransactionHash).toHaveBeenCalledExactlyOnceWith({
        chainId: 369,
        request: REQUEST,
        hash: '0xabc',
      })
      expect(onPhase).toHaveBeenCalledTimes(2)
    })
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
