/**
 * Anvil-backed integration test config for @valve-tech/wallet-adapter.
 *
 * Picks up only `*.integration.test.ts`. Each test file spawns anvil
 * via prool in beforeAll, runs the bridge against a real chain + a
 * real SDK (viem WalletClient, ethers Wallet, @safe-global/protocol-kit),
 * and tears anvil down on afterAll.
 *
 * Requires foundry (`anvil`) installed on the system. CI installs
 * foundry via foundry-toolchain action; local devs run
 * `curl -L https://foundry.paradigm.xyz | bash && foundryup` once.
 *
 * Run via `yarn test:integration`. Not in the default `yarn test`
 * chain because of the anvil startup cost (~1s per file) and the
 * foundry dep.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    // Each file owns its own anvil port (8745, 8746, ...) so files
    // can run in parallel without port races.
    // Per-file timeout — anvil startup + the actual tx mining adds
    // up to ~5s in the worst case.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
