import { describe, it, expect, expectTypeOf, vi } from 'vitest'
import type { Block, Hex, TransactionReceipt } from 'viem'
import type {
  TxContext,
  WriteHookParams,
  WritePhase,
  WritePhaseEvent,
  WritePhaseSteps,
} from './hooks.js'
import type { WalletSendTransactionRequest } from './wallet.js'

const REQUEST: WalletSendTransactionRequest = {
  to: '0x1111111111111111111111111111111111111111' as Hex,
  data: '0xdeadbeef' as Hex,
  chainId: 369,
}

describe('WritePhase', () => {
  it('is the union of every named lifecycle phase', () => {
    expectTypeOf<WritePhase>().toEqualTypeOf<
      | 'preparing'
      | 'awaiting-signature'
      | 'pending'
      | 'confirmed'
      | 'failed'
      | 'dropped'
      | 'replaced'
    >()
  })
})

describe('WritePhaseSteps', () => {
  it('preparing carries no extra delta', () => {
    expectTypeOf<WritePhaseSteps['preparing']>().toEqualTypeOf<object>()
  })

  it('awaiting-signature carries no extra delta', () => {
    expectTypeOf<WritePhaseSteps['awaiting-signature']>().toEqualTypeOf<object>()
  })

  it('pending carries hash', () => {
    expectTypeOf<WritePhaseSteps['pending']>().toEqualTypeOf<{ hash: Hex }>()
  })

  it('confirmed carries hash, receipt, and optional block', () => {
    expectTypeOf<WritePhaseSteps['confirmed']>().toEqualTypeOf<{
      hash: Hex
      receipt: TransactionReceipt
      block?: Block
    }>()
  })

  it('failed carries error plus optional hash/receipt/block', () => {
    expectTypeOf<WritePhaseSteps['failed']>().toEqualTypeOf<{
      error: Error
      hash?: Hex
      receipt?: TransactionReceipt
      block?: Block
    }>()
  })

  it('dropped carries hash', () => {
    expectTypeOf<WritePhaseSteps['dropped']>().toEqualTypeOf<{ hash: Hex }>()
  })

  it('replaced carries original/replacement hashes plus optional receipt/block', () => {
    expectTypeOf<WritePhaseSteps['replaced']>().toEqualTypeOf<{
      original: Hex
      replacement: Hex
      receipt?: TransactionReceipt
      block?: Block
    }>()
  })
})

describe('TxContext', () => {
  it('intersects an Extra delta into the always-present context', () => {
    expectTypeOf<TxContext<{ hash: Hex }>>().toEqualTypeOf<{
      chainId: number
      request: WalletSendTransactionRequest
    } & { hash: Hex }>()
  })

  it('a runtime ctx satisfies the default shape', () => {
    const ctx: TxContext = { chainId: 369, request: REQUEST }
    expect(ctx.chainId).toBe(369)
    expect(ctx.request).toBe(REQUEST)
  })
})

describe('WritePhaseEvent', () => {
  it('is the discriminated union of phase + TxContext<Steps[K]>', () => {
    expectTypeOf<WritePhaseEvent>().toEqualTypeOf<
      {
        [K in keyof WritePhaseSteps]: { phase: K } & TxContext<WritePhaseSteps[K]>
      }[keyof WritePhaseSteps]
    >()
  })

  it("narrows phase='preparing' to chainId+request only (no extras)", () => {
    const event = { phase: 'preparing', chainId: 369, request: REQUEST } satisfies WritePhaseEvent
    if (event.phase === 'preparing') {
      expectTypeOf(event).toExtend<{ chainId: number; request: WalletSendTransactionRequest }>()
    }
  })

  it("narrows phase='confirmed' to hash + receipt + optional block + context", () => {
    const event = {
      phase: 'confirmed',
      chainId: 369,
      request: REQUEST,
      hash: '0xabc' as Hex,
      receipt: { status: 'success' } as unknown as TransactionReceipt,
    } satisfies WritePhaseEvent
    if (event.phase === 'confirmed') {
      expectTypeOf(event).toExtend<{
        hash: Hex
        receipt: TransactionReceipt
        chainId: number
        request: WalletSendTransactionRequest
      }>()
    }
  })

  it("narrows phase='replaced' to original + replacement + context", () => {
    const event = {
      phase: 'replaced',
      chainId: 369,
      request: REQUEST,
      original: '0xaaa' as Hex,
      replacement: '0xbbb' as Hex,
    } satisfies WritePhaseEvent
    if (event.phase === 'replaced') {
      expectTypeOf(event).toExtend<{
        original: Hex
        replacement: Hex
        chainId: number
      }>()
    }
  })
})

describe('WriteHookParams', () => {
  it('all fields are optional — empty params is valid', () => {
    const params: WriteHookParams = {}
    expect(params.onAwaitingSignature).toBeUndefined()
    expect(params.onTransactionHash).toBeUndefined()
    expect(params.onConfirmed).toBeUndefined()
    expect(params.onFailed).toBeUndefined()
    expect(params.onDropped).toBeUndefined()
    expect(params.onReplaced).toBeUndefined()
    expect(params.onPhase).toBeUndefined()
  })

  it('onAwaitingSignature receives TxContext (chainId + request)', () => {
    expectTypeOf<WriteHookParams['onAwaitingSignature']>().toEqualTypeOf<
      ((info: TxContext<WritePhaseSteps['awaiting-signature']>) => void) | undefined
    >()
  })

  it('onTransactionHash receives TxContext<{ hash }>', () => {
    expectTypeOf<WriteHookParams['onTransactionHash']>().toEqualTypeOf<
      ((info: TxContext<WritePhaseSteps['pending']>) => void) | undefined
    >()
  })

  it('onConfirmed receives TxContext<{ hash, receipt, block? }>', () => {
    expectTypeOf<WriteHookParams['onConfirmed']>().toEqualTypeOf<
      ((info: TxContext<WritePhaseSteps['confirmed']>) => void) | undefined
    >()
  })

  it('onFailed receives TxContext<{ error, hash?, receipt?, block? }>', () => {
    expectTypeOf<WriteHookParams['onFailed']>().toEqualTypeOf<
      ((info: TxContext<WritePhaseSteps['failed']>) => void) | undefined
    >()
  })

  it('onDropped receives TxContext<{ hash }>', () => {
    expectTypeOf<WriteHookParams['onDropped']>().toEqualTypeOf<
      ((info: TxContext<WritePhaseSteps['dropped']>) => void) | undefined
    >()
  })

  it('onReplaced receives TxContext<{ original, replacement, receipt?, block? }>', () => {
    expectTypeOf<WriteHookParams['onReplaced']>().toEqualTypeOf<
      ((info: TxContext<WritePhaseSteps['replaced']>) => void) | undefined
    >()
  })

  it('onPhase receives the discriminated WritePhaseEvent', () => {
    expectTypeOf<WriteHookParams['onPhase']>().toEqualTypeOf<
      ((event: WritePhaseEvent) => void) | undefined
    >()
  })

  it('a params object can wire every hook with rich payloads', () => {
    const onAwaitingSignature = vi.fn()
    const onTransactionHash = vi.fn()
    const onConfirmed = vi.fn()
    const onFailed = vi.fn()
    const onDropped = vi.fn()
    const onReplaced = vi.fn()
    const onPhase = vi.fn()
    const params: WriteHookParams = {
      onAwaitingSignature,
      onTransactionHash,
      onConfirmed,
      onFailed,
      onDropped,
      onReplaced,
      onPhase,
    }

    const ctx: TxContext = { chainId: 369, request: REQUEST }
    params.onAwaitingSignature?.(ctx)
    params.onTransactionHash?.({ ...ctx, hash: '0xabc' as Hex })

    expect(onAwaitingSignature).toHaveBeenCalledExactlyOnceWith(ctx)
    expect(onTransactionHash).toHaveBeenCalledExactlyOnceWith({ ...ctx, hash: '0xabc' })
  })
})
