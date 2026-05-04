/**
 * Stub-package smoke test for v0.0.1.
 *
 * Asserts that the placeholder index emits no symbols. When v0.1.0
 * implementation lands, this test gets replaced with real coverage.
 */
import { test, expect } from 'vitest'
import * as ChainSource from './index.js'

test('chain-source v0.0.1 is a stub — no symbols exported yet', () => {
  expect(Object.keys(ChainSource)).toEqual([])
})
