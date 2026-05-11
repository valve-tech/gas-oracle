/**
 * Vitest browser-mode globalSetup. Runs in Node (NOT in the browser)
 * before any browser test file imports. Spawns anvil so browser tests
 * have a real chain to talk to over `fetch` / RPC.
 *
 * Browser tests `inject('anvilUrl')` to discover the URL.
 */
import { createAnvilFixture } from './src/anvil-fixture.js'

const anvil = createAnvilFixture(8845)

export default async ({ provide }: { provide: (key: string, value: unknown) => void }) => {
  await anvil.start()
  provide('anvilUrl', anvil.url)
  return async () => {
    await anvil.stop()
  }
}

// Vitest provide / inject type augmentation.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedContext {
    anvilUrl: string
  }
}
