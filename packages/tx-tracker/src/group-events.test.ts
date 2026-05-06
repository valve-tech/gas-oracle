import { test, expect } from 'vitest'

import {
  buildGroupComplete,
  buildGroupFailed,
  buildGroupProgress,
  buildGroupStopped,
} from './group-events.js'

const ENVELOPE = { groupId: 'g1', at: { blockNumber: 100n, timestamp: 1n } }

test('buildGroupProgress', () => {
  const ev = buildGroupProgress({ ...ENVELOPE, confirmed: 1, total: 3, lastHash: '0xa' })
  expect(ev).toEqual({
    kind: 'group-progress',
    groupId: 'g1',
    at: { blockNumber: 100n, timestamp: 1n },
    confirmed: 1,
    total: 3,
    lastHash: '0xa',
  })
})

test('buildGroupComplete', () => {
  const ev = buildGroupComplete({ ...ENVELOPE, total: 3 })
  expect(ev.kind).toBe('group-complete')
  expect(ev.total).toBe(3)
})

test('buildGroupFailed with reason "dropped"', () => {
  const ev = buildGroupFailed({ ...ENVELOPE, failedHash: '0xb', reason: 'dropped' })
  expect(ev.kind).toBe('group-failed')
  expect(ev.failedHash).toBe('0xb')
  expect(ev.reason).toBe('dropped')
})

test('buildGroupFailed with reason "failed"', () => {
  const ev = buildGroupFailed({ ...ENVELOPE, failedHash: '0xc', reason: 'failed' })
  expect(ev.kind).toBe('group-failed')
  expect(ev.failedHash).toBe('0xc')
  expect(ev.reason).toBe('failed')
})

test('buildGroupFailed with reason "replaced"', () => {
  const ev = buildGroupFailed({ ...ENVELOPE, failedHash: '0xd', reason: 'replaced' })
  expect(ev.kind).toBe('group-failed')
  expect(ev.failedHash).toBe('0xd')
  expect(ev.reason).toBe('replaced')
})

test('buildGroupStopped', () => {
  const ev = buildGroupStopped(ENVELOPE)
  expect(ev.kind).toBe('group-stopped')
})

test('envelope is copied (no aliasing) in buildGroupProgress', () => {
  const at = { blockNumber: 7n, timestamp: 1n }
  const ev = buildGroupProgress({ groupId: 'g1', at, confirmed: 1, total: 1, lastHash: '0x' })
  expect(ev.at).not.toBe(at)
  expect(ev.at).toEqual(at)
})

test('envelope is copied (no aliasing) in buildGroupComplete', () => {
  const at = { blockNumber: 8n, timestamp: 2n }
  const ev = buildGroupComplete({ groupId: 'g2', at, total: 2 })
  expect(ev.at).not.toBe(at)
  expect(ev.at).toEqual(at)
})

test('envelope is copied (no aliasing) in buildGroupFailed', () => {
  const at = { blockNumber: 9n, timestamp: 3n }
  const ev = buildGroupFailed({ groupId: 'g3', at, failedHash: '0xe', reason: 'dropped' })
  expect(ev.at).not.toBe(at)
  expect(ev.at).toEqual(at)
})

test('envelope is copied (no aliasing) in buildGroupStopped', () => {
  const at = { blockNumber: 10n, timestamp: 4n }
  const ev = buildGroupStopped({ groupId: 'g4', at })
  expect(ev.at).not.toBe(at)
  expect(ev.at).toEqual(at)
})
