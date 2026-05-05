import { describe, it, expect, expectTypeOf, vi } from 'vitest'
import type { Hex } from 'viem'
import type {
  WriteHookParams,
  WritePhase,
  WritePhaseHookParams,
  WritePhaseContext,
} from './hooks.js'

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

  it('onTransactionHash receives a Hex argument', () => {
    expectTypeOf<WriteHookParams['onTransactionHash']>()
      .toEqualTypeOf<((hash: Hex) => void) | undefined>()
  })
})

describe('WritePhase', () => {
  it('declares the four canonical phases', () => {
    const phases: WritePhase[] = ['preparing', 'awaiting-signature', 'broadcasted', 'mined']
    expect(phases).toEqual(['preparing', 'awaiting-signature', 'broadcasted', 'mined'])
  })

  it('is a string-literal union (compile-time check)', () => {
    expectTypeOf<WritePhase>()
      .toEqualTypeOf<'preparing' | 'awaiting-signature' | 'broadcasted' | 'mined'>()
  })
})

describe('WritePhaseHookParams', () => {
  it('onPhase fires with phase + optional context', () => {
    const onPhase = vi.fn<(phase: WritePhase, context?: WritePhaseContext) => void>()
    const params: WritePhaseHookParams = { onPhase }

    params.onPhase?.('preparing')
    params.onPhase?.('awaiting-signature')
    params.onPhase?.('broadcasted', { hash: '0xabc' })
    params.onPhase?.('mined', { hash: '0xabc', receipt: { blockNumber: 1n } })

    expect(onPhase).toHaveBeenCalledTimes(4)
    expect(onPhase).toHaveBeenLastCalledWith('mined', { hash: '0xabc', receipt: { blockNumber: 1n } })
  })
})
