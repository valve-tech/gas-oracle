/**
 * Public-surface smoke test. Confirms the symbols documented in
 * README + spec §3.5 are actually exported from the package entry.
 * Catches accidental drops in re-exports during refactors.
 */
import { test, expect } from 'vitest'

import * as ChainSource from './index.js'

test('public surface exposes createChainSource factory', () => {
  expect(typeof ChainSource.createChainSource).toBe('function')
})

test('public surface exposes the Subscriptions primitive', () => {
  expect(typeof ChainSource.Subscriptions).toBe('function')
})

test('public surface exposes normalizeMempool helper', () => {
  expect(typeof ChainSource.normalizeMempool).toBe('function')
})

test('public surface exposes probeCapabilities', () => {
  expect(typeof ChainSource.probeCapabilities).toBe('function')
})

test('public surface exposes the transport helpers', () => {
  expect(typeof ChainSource.safeRequest).toBe('function')
  expect(typeof ChainSource.fetchBlock).toBe('function')
  expect(typeof ChainSource.fetchHeadBlockNumber).toBe('function')
  expect(typeof ChainSource.fetchFeeHistory).toBe('function')
  expect(typeof ChainSource.fetchTxPool).toBe('function')
  expect(typeof ChainSource.fetchReceipt).toBe('function')
  expect(typeof ChainSource.fetchTransaction).toBe('function')
  expect(ChainSource.zeroHash).toBe(`0x${'00'.repeat(32)}`)
})
