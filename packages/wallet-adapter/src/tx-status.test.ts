import { describe, it, expect, expectTypeOf } from 'vitest'
import {
  TX_STATUS,
  TX_FLOW,
  STALE_TX_AGE_MS,
  CONFIRMED_DISPLAY_MS,
  FAILED_DISPLAY_MS,
  type TrackedTx,
  type TrackedTxStatus,
  type TxFlow,
} from './tx-status.js'

describe('TX_STATUS', () => {
  it('declares each status as its own kebab-case literal', () => {
    expect(TX_STATUS.preparing).toBe('preparing')
    expect(TX_STATUS.awaitingSignature).toBe('awaiting-signature')
    expect(TX_STATUS.pending).toBe('pending')
    expect(TX_STATUS.mined).toBe('mined')
    expect(TX_STATUS.failed).toBe('failed')
    expect(TX_STATUS.replaced).toBe('replaced')
    expect(TX_STATUS.dropped).toBe('dropped')
  })

  it('every value is unique — no two states collide', () => {
    const values = Object.values(TX_STATUS)
    expect(new Set(values).size).toBe(values.length)
  })

  it('TrackedTxStatus accepts each declared status', () => {
    expectTypeOf<TrackedTxStatus>().toEqualTypeOf<
      'preparing' | 'awaiting-signature' | 'pending' | 'mined' | 'failed' | 'replaced' | 'dropped'
    >()
  })
})

describe('TX_FLOW', () => {
  it('ships empty by design — protocols add their own flow names', () => {
    expect(Object.keys(TX_FLOW)).toHaveLength(0)
  })

  it('TxFlow narrows to string so consumers can extend with their own literals', () => {
    expectTypeOf<TxFlow>().toEqualTypeOf<string>()
  })
})

describe('display windows', () => {
  it('STALE_TX_AGE_MS is 10 minutes', () => {
    expect(STALE_TX_AGE_MS).toBe(10 * 60 * 1000)
  })

  it('CONFIRMED and FAILED windows are symmetric so success / error feel equivalent', () => {
    expect(CONFIRMED_DISPLAY_MS).toBe(FAILED_DISPLAY_MS)
    expect(CONFIRMED_DISPLAY_MS).toBe(10_000)
  })
})

describe('TrackedTx', () => {
  it('id is required, hash is optional (pre-hash states have no hash)', () => {
    // Pre-hash construction — valid, no hash yet.
    const t: TrackedTx = {
      id: 'tx-1',
      chainId: 369,
      flow: 'fulfillIntent',
      submittedAt: 0,
      submittedTier: 'standard',
      status: TX_STATUS.preparing,
    }
    expect(t.hash).toBeUndefined()
    expect(t.id).toBe('tx-1')
  })

  it('post-hash construction carries hash + submittedGas', () => {
    const t: TrackedTx = {
      id: 'tx-2',
      hash: '0xabc',
      chainId: 369,
      flow: 'addFunds',
      submittedAt: 0,
      submittedTier: 'fast',
      status: TX_STATUS.pending,
      submittedGas: { maxFeePerGas: 100n, maxPriorityFeePerGas: 20n },
    }
    expect(t.hash).toBe('0xabc')
    expect(t.submittedGas?.maxFeePerGas).toBe(100n)
  })
})
