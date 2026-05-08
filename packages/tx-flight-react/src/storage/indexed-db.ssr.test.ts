// @vitest-environment node
//
// Verifies the SSR-safe code path of `indexedDBAdapter` — when the
// runtime has no `indexedDB`, both methods resolve cleanly.

import { test, expect } from 'vitest'

import { indexedDBAdapter } from './indexed-db.js'

test('indexedDBAdapter.load returns null under node (no indexedDB)', async () => {
  const adapter = indexedDBAdapter()
  expect(await adapter.load('default')).toBeNull()
})

test('indexedDBAdapter.save resolves without throwing under node', async () => {
  const adapter = indexedDBAdapter()
  await expect(adapter.save('default', [])).resolves.toBeUndefined()
})
