/**
 * Anvil's deterministic 10-account list — re-exported here as plain
 * data so browser-mode test files can import it without pulling in
 * the Node-only `createAnvilFixture` (which uses `node:child_process`
 * and crashes the browser bundler).
 *
 * These are well-known throwaway keys baked into anvil's default
 * mnemonic. Every account has 10_000 ETH on a fresh anvil instance.
 * NEVER use these on any real chain.
 */
export const ANVIL_ACCOUNTS = {
  relayer: {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const,
    privateKey:
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const,
  },
  recipient: {
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const,
    privateKey:
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const,
  },
  cosigner: {
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const,
    privateKey:
      '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const,
  },
} as const
