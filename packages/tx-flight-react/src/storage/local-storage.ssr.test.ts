// @vitest-environment node
//
// Verifies the SSR-safe code path of `localStorageAdapter` — when the
// runtime has no `window`, both methods resolve cleanly.

import { test, expect } from 'vitest'

import { localStorageAdapter } from './local-storage.js'

test('localStorageAdapter.load returns null under node (no window)', async () => {
  const adapter = localStorageAdapter()
  expect(await adapter.load('default')).toBeNull()
})

test('localStorageAdapter.save resolves without throwing under node', async () => {
  const adapter = localStorageAdapter()
  await expect(adapter.save('default', [])).resolves.toBeUndefined()
})
