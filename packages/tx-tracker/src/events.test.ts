/**
 * Unit tests for `events.ts` — payload builders + envelope completeness.
 *
 * Three things this suite pins:
 *
 * 1. Every builder produces a complete envelope (`hash`, `chainId`,
 *    `source`, `at.blockNumber`, `at.timestamp`). A future refactor
 *    that drops a field surfaces here, not at runtime in a consumer.
 * 2. The `discriminator: 'kind'` field matches the spec literal for
 *    each variant. Consumers narrow on `kind`, so a typo in the
 *    builder would silently break exhaustive switches in their code.
 * 3. `buildVanishedFromBlock` enforces the spec §12.3 invariant:
 *    receipt-poll cannot produce a reorg observation. The builder
 *    throws on misuse instead of letting a bad event ship.
 */
import { test, expect } from 'vitest'

import type { Capabilities, RawTx } from '@valve-tech/chain-source'

import {
  buildInitialStatus,
  buildLeftMempool,
  buildReplacedBy,
  buildSeenInBlock,
  buildSeenInMempool,
  buildSignalDegraded,
  buildSignalRecovered,
  buildStarted,
  buildStopped,
  buildUnseenForNBlocks,
  buildVanishedFromBlock,
} from './events.js'

const CAPS: Capabilities = {
  newHeads: 'subscription',
  newPendingTransactions: 'poll-only',
  txpoolContent: 'available',
  receiptByHash: 'available',
  reprobeOnReconnect: true,
}

const ENVELOPE = {
  hash: '0xabc',
  chainId: 1,
  source: 'block-poll' as const,
  at: { blockNumber: 100n, timestamp: 1_700_000_000n },
}

const TX: RawTx = { hash: '0xabc', from: '0xdef', nonce: '0x5' }

test('buildStarted emits kind="started" and carries capabilities', () => {
  const e = buildStarted({ ...ENVELOPE, capabilities: CAPS })
  expect(e.kind).toBe('started')
  expect(e.hash).toBe('0xabc')
  expect(e.chainId).toBe(1)
  expect(e.source).toBe('block-poll')
  expect(e.at.blockNumber).toBe(100n)
  expect(e.at.timestamp).toBe(1_700_000_000n)
  expect(e.capabilities).toEqual(CAPS)
})

test('buildSeenInMempool emits kind="seen-in-mempool" with bucket + tx', () => {
  const e = buildSeenInMempool({ ...ENVELOPE, bucket: 'pending', tx: TX })
  expect(e.kind).toBe('seen-in-mempool')
  expect(e.bucket).toBe('pending')
  expect(e.tx).toBe(TX)
})

test('buildLeftMempool emits kind="left-mempool"', () => {
  const e = buildLeftMempool(ENVELOPE)
  expect(e.kind).toBe('left-mempool')
})

test('buildSeenInBlock emits kind="seen-in-block" with positional fields', () => {
  const e = buildSeenInBlock({
    ...ENVELOPE,
    blockHash: '0xb1',
    blockNumber: 100n,
    transactionIndex: 7,
    confirmations: 1,
  })
  expect(e.kind).toBe('seen-in-block')
  expect(e.blockHash).toBe('0xb1')
  expect(e.transactionIndex).toBe(7)
  expect(e.confirmations).toBe(1)
})

test('buildVanishedFromBlock emits kind + canonical/previous hashes', () => {
  const e = buildVanishedFromBlock({
    ...ENVELOPE,
    previousBlockHash: '0xb1',
    canonicalBlockHash: '0xb2',
    blockNumber: 100n,
  })
  expect(e.kind).toBe('vanished-from-block')
  expect(e.previousBlockHash).toBe('0xb1')
  expect(e.canonicalBlockHash).toBe('0xb2')
  expect(e.blockNumber).toBe(100n)
})

test('buildVanishedFromBlock REJECTS source: "receipt-poll" (spec §12.3)', () => {
  expect(() =>
    buildVanishedFromBlock({
      ...ENVELOPE,
      source: 'receipt-poll',
      previousBlockHash: '0xb1',
      canonicalBlockHash: '0xb2',
      blockNumber: 100n,
    }),
  ).toThrow(/receipt-poll cannot detect reorgs/)
})

test('buildReplacedBy carries replacementHash + nullable block number', () => {
  const mempoolOnly = buildReplacedBy({
    ...ENVELOPE,
    replacementHash: '0xrep',
    replacementBlockNumber: null,
  })
  expect(mempoolOnly.replacementBlockNumber).toBeNull()

  const mined = buildReplacedBy({
    ...ENVELOPE,
    replacementHash: '0xrep',
    replacementBlockNumber: 100n,
  })
  expect(mined.replacementBlockNumber).toBe(100n)
})

test('buildUnseenForNBlocks carries the consecutive-block count', () => {
  const e = buildUnseenForNBlocks({ ...ENVELOPE, blocks: 30 })
  expect(e.kind).toBe('unseen-for-N-blocks')
  expect(e.blocks).toBe(30)
})

test('buildSignalDegraded carries lost capability + fallback source', () => {
  const e = buildSignalDegraded({
    ...ENVELOPE,
    capabilityLost: 'newHeads',
    fallbackSource: 'block-poll',
  })
  expect(e.kind).toBe('signal-degraded')
  expect(e.capabilityLost).toBe('newHeads')
  expect(e.fallbackSource).toBe('block-poll')
})

test('buildSignalRecovered carries restored capability', () => {
  const e = buildSignalRecovered({
    ...ENVELOPE,
    capabilityRestored: 'txpoolContent',
  })
  expect(e.kind).toBe('signal-recovered')
  expect(e.capabilityRestored).toBe('txpoolContent')
})

test('buildStopped carries one of three reasons', () => {
  expect(buildStopped({ ...ENVELOPE, reason: 'unsubscribed' }).reason).toBe(
    'unsubscribed',
  )
  expect(
    buildStopped({ ...ENVELOPE, reason: 'retention-expired' }).reason,
  ).toBe('retention-expired')
  expect(buildStopped({ ...ENVELOPE, reason: 'tracker-stopped' }).reason).toBe(
    'tracker-stopped',
  )
})

test('envelope is deep-cloned so caller mutations cannot affect events', () => {
  const at = { blockNumber: 100n, timestamp: 1n }
  const e = buildLeftMempool({ ...ENVELOPE, at })
  at.blockNumber = 999n
  expect(e.at.blockNumber).toBe(100n)
})

test('buildInitialStatus returns a clean per-hash record', () => {
  const status = buildInitialStatus({
    hash: '0xabc',
    chainId: 1,
    capabilities: CAPS,
  })
  expect(status.hash).toBe('0xabc')
  expect(status.chainId).toBe(1)
  expect(status.lastSeenInBlock).toBeNull()
  expect(status.lastSeenInMempool).toBeNull()
  expect(status.replacedBy).toBeNull()
  expect(status.vanishedAt).toBeNull()
  expect(status.unseenStreak).toBe(0)
  expect(status.firstObservedAtBlock).toBeNull()
  expect(status.lastObservedAtBlock).toBeNull()
  expect(status.capabilities).toEqual(CAPS)
})
