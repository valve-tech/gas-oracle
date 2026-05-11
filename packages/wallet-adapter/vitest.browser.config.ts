/**
 * Browser-mode test config for @valve-tech/wallet-adapter.
 *
 * Runs tests in a real Chromium via Playwright (Vitest browser mode).
 * Use this for tests that need a DOM, a real fetch / window, or that
 * exercise wallet-bridge code paths that browsers run differently
 * than Node (EIP-1193 providers, viem's `custom` transport with
 * window.ethereum-shaped objects).
 *
 * Node-only tests stay in vitest.config.ts (or the default) and run
 * via `yarn test`. Browser tests run via `yarn test:browser`. Two
 * separate runners so the Node suite doesn't pay the Chromium
 * startup cost on every change.
 */
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
    include: ['src/**/*.browser.test.ts'],
    globalSetup: ['./vitest.browser.globalsetup.ts'],
  },
})
