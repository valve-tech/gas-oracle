import { describe, it, expect, expectTypeOf, vi } from 'vitest'
import type { Hex } from 'viem'
import type { WriteHookParams } from './hooks.js'

describe('WriteHookParams', () => {
  it('a params object satisfies the contract with both hooks present', () => {
    const onAwaitingSignature = vi.fn()
    const onTransactionHash = vi.fn()
    const params: WriteHookParams = { onAwaitingSignature, onTransactionHash }

    params.onAwaitingSignature?.()
    params.onTransactionHash?.('0xabc')

    expect(onAwaitingSignature).toHaveBeenCalledOnce()
    expect(onTransactionHash).toHaveBeenCalledExactlyOnceWith('0xabc')
  })

  it('both hooks are optional — empty params is valid', () => {
    const params: WriteHookParams = {}
    expect(params.onAwaitingSignature).toBeUndefined()
    expect(params.onTransactionHash).toBeUndefined()
  })

  it('onAwaitingSignature is a no-arg void callback', () => {
    expectTypeOf<WriteHookParams['onAwaitingSignature']>()
      .toEqualTypeOf<(() => void) | undefined>()
  })

  it('onTransactionHash receives a Hex argument', () => {
    expectTypeOf<WriteHookParams['onTransactionHash']>()
      .toEqualTypeOf<((hash: Hex) => void) | undefined>()
  })
})
