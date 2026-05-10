/**
 * Unit tests for the pure sample-extraction helpers in `samples.ts`.
 * Targets the previously-uncovered defensive arms of the hex-decode
 * helpers and the malformed-input fallbacks in `mempoolToSamples`.
 */
import type { BlockResult, TxPoolContent } from '@valve-tech/chain-source'
import { test, expect } from 'vitest'

import { blockToSample, mempoolToSamples } from './samples.js'

const hex = (n: bigint) => '0x' + n.toString(16)

const block = (overrides: Partial<BlockResult> = {}): BlockResult => ({
  number: '0x10',
  timestamp: '0x1',
  baseFeePerGas: hex(1_000_000_000n),
  gasLimit: '0x5208',
  gasUsed: '0x5208',
  transactions: [],
  ...overrides,
})

test('mempoolToSamples returns [] for null / undefined pool', () => {
  expect(mempoolToSamples(null, 0n)).toEqual([])
  expect(mempoolToSamples(undefined, 0n)).toEqual([])
})

test('mempoolToSamples handles a pool with NO pending field (?? {} fallback)', () => {
  // Drives the `pool.pending ?? {}` defensive arm — a malformed
  // snapshot that lacks the `pending` key still returns cleanly
  // (empty samples) instead of throwing on `Object.entries(undefined)`.
  const pool = { queued: {} } as unknown as TxPoolContent
  expect(mempoolToSamples(pool, 0n)).toEqual([])
})

test('mempoolToSamples falls back to tx.nonce when the key fails to decode', () => {
  // Drives the `decodeNonce(nonce) ?? decodeNonce(tx.nonce)` arm:
  // the outer-map nonce-key is non-hex (so decodeNonce returns
  // undefined), but the inner tx.nonce field IS hex and supplies
  // the canonical value.
  const pool: TxPoolContent = {
    pending: {
      '0xs': {
        // Nonce key 'xyz' fails decodeNonce; tx.nonce '0x5' decodes to '5'
        xyz: { hash: '0xt1', nonce: '0x5', gas: '0x5208' },
      },
    },
    queued: {},
  }
  const samples = mempoolToSamples(pool, 0n)
  expect(samples).toHaveLength(1)
  expect(samples[0]!.nonce).toBe('5')
})

test('blockToSample returns undefined nonce for a tx with non-decodable nonce', () => {
  // Drives the BigInt() catch in `decodeNonce` — a tx whose nonce
  // field is neither hex nor decimal returns `undefined` instead
  // of throwing.
  const sample = blockToSample(
    block({
      transactions: [
        {
          hash: '0xt1',
          from: '0xs',
          nonce: 'not-a-number',
          gas: '0x5208',
          maxPriorityFeePerGas: hex(1_000_000_000n),
          maxFeePerGas: hex(2_000_000_000n),
          type: '0x2',
        },
      ],
    }),
  )
  expect(sample.tips[0]!.nonce).toBeUndefined()
})

test('blockToSample skips txs missing the gas field', () => {
  const sample = blockToSample(
    block({
      transactions: [
        { hash: '0xnogas', from: '0xs', nonce: '0x1' },
        {
          hash: '0xok',
          from: '0xs',
          nonce: '0x2',
          gas: '0x5208',
          maxPriorityFeePerGas: hex(1n),
          maxFeePerGas: hex(2n),
          type: '0x2',
        },
      ],
    }),
  )
  expect(sample.tips.map((t) => t.hash)).toEqual(['0xok'])
})
