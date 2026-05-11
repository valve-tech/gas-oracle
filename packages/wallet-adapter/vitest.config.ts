/**
 * Default Node test config for @valve-tech/wallet-adapter.
 *
 * Excludes:
 * - `*.browser.test.ts` — runs in Chromium via vitest.browser.config.ts
 *   (`yarn test:browser`).
 * - `*.integration.test.ts` — needs anvil running, separate cost and
 *   external foundry dep; runs via vitest.integration.config.ts
 *   (`yarn test:integration`).
 *
 * The default `yarn test` runs unit tests only, fast and dep-free.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.integration.test.ts',
    ],
  },
})
