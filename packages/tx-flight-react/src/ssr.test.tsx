// @vitest-environment node

/**
 * SSR safety suite. Runs under the `node` environment (no `window`,
 * no `document`, no `localStorage`) to prove every public surface of
 * the package is safe to import + render server-side.
 *
 * The Provider's heavyweight side effects (eviction interval, storage
 * IO) live inside `useEffect`, which `react-dom/server` does not run.
 * Lazy `useState` init runs server-side and must not crash.
 */

import { test, expect } from 'vitest'
import { renderToString } from 'react-dom/server'

import * as TxFlightReact from './index.js'
import { localStorageAdapter } from './storage/local-storage.js'

test('every named export from the package barrel is importable under node env', () => {
  expect(TxFlightReact.TxFlightProvider).toBeTypeOf('function')
  expect(TxFlightReact.useTxFlight).toBeTypeOf('function')
  expect(TxFlightReact.TxFlightStatusIcon).toBeTypeOf('function')
  expect(TxFlightReact.TxFlightHashLink).toBeTypeOf('function')
  expect(TxFlightReact.TxFlightAge).toBeTypeOf('function')
  expect(TxFlightReact.TxFlightActions).toBeTypeOf('function')
  expect(TxFlightReact.TxFlightItem).toBeTypeOf('function')
  expect(TxFlightReact.TxFlightList).toBeTypeOf('function')
})

test('localStorageAdapter under node: load → null, save → resolved no-op', async () => {
  const storage = localStorageAdapter()
  expect(await storage.load('any')).toBeNull()
  await expect(storage.save('any', [])).resolves.toBeUndefined()
})

test('<TxFlightProvider> renderToString does not crash on the server', () => {
  const html = renderToString(
    <TxFlightReact.TxFlightProvider id="ssr-test" storage={null}>
      <span data-marker="ssr">hello</span>
    </TxFlightReact.TxFlightProvider>,
  )
  expect(html).toContain('hello')
  expect(html).toContain('data-marker="ssr"')
})
