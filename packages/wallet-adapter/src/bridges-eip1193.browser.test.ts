/**
 * Real-browser integration test for `walletAdapterFromEip1193` from
 * `examples/01-reown-adapter.ts`.
 *
 * Runs in a Chromium context via Vitest browser mode (Playwright).
 * Verifies that the bridge code works against a viem `WalletClient`
 * with a `custom` transport in an actual browser runtime — catches
 * Node-only assumptions (Buffer, process, etc.) that the
 * fake-stub Node sanity check at the bottom of the example file
 * wouldn't see.
 *
 * Why browser-mode: the EIP-1193 bridge is *the* path used by
 * Reown / WalletConnect / MetaMask / RainbowKit / hardware wallets
 * in browser context. If viem's `custom` transport interacted
 * differently with a fake provider object in a browser vs Node
 * (e.g. via `window.crypto` shims, fetch polyfill drift, ...) the
 * Node-only sanity check would miss it.
 *
 * The provider here is a deterministic in-process mock — no real
 * RPC, no real chain. Anvil-backed browser tests live in
 * `bridges-eip1193-anvil.browser.test.ts` (Phase 3).
 */
import { test, expect } from 'vitest'

import type { EIP1193Provider, Hex } from 'viem'

import { walletAdapterFromEip1193 } from '../examples/01-reown-adapter.js'

const FAKE_ADDRESS = ('0x' + 'a'.repeat(40)) as Hex
const FAKE_TX_HASH = ('0x' + '1'.repeat(64)) as Hex

const mockProvider = (overrides: {
  chainId?: string
  onSwitch?: (chainId: string) => void
} = {}): EIP1193Provider => {
  let currentChainHex = overrides.chainId ?? '0x1'
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') return currentChainHex
      if (method === 'eth_accounts') return [FAKE_ADDRESS]
      if (method === 'eth_getTransactionCount') return '0x0'
      if (method === 'eth_estimateGas') return '0x5208'
      if (method === 'eth_gasPrice') return '0x77359400'
      if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00'
      if (method === 'eth_sendTransaction') return FAKE_TX_HASH
      if (method === 'wallet_switchEthereumChain') {
        const target = (params as [{ chainId: string }])[0]?.chainId
        if (target) {
          currentChainHex = target
          overrides.onSwitch?.(target)
        }
        return null
      }
      throw new Error(`mockProvider: unexpected method ${method}`)
    },
  } as unknown as EIP1193Provider
}

test('walletAdapterFromEip1193 sends a transaction in a real browser', async () => {
  // Smoke test in Chromium: bridge code path executes end-to-end,
  // the viem WalletClient + `custom` transport play nicely with
  // the EIP-1193 mock, the hash propagates back through the adapter.
  const adapter = walletAdapterFromEip1193({
    provider: mockProvider(),
    account: FAKE_ADDRESS,
  })

  const hash = await adapter.sendTransaction({
    to: ('0x' + 'b'.repeat(40)) as Hex,
    data: '0x',
    value: 1n,
    chainId: 1,
  })

  expect(hash).toBe(FAKE_TX_HASH)
  expect(adapter.address).toBe(FAKE_ADDRESS)
})

test('walletAdapterFromEip1193 throws on chain mismatch with the fail-fast default', async () => {
  const adapter = walletAdapterFromEip1193({
    provider: mockProvider({ chainId: '0x1' }),
    account: FAKE_ADDRESS,
  })

  await expect(
    adapter.sendTransaction({
      to: ('0x' + 'b'.repeat(40)) as Hex,
      data: '0x',
      value: 0n,
      chainId: 137, // mismatched
    }),
  ).rejects.toThrow(/wallet is on chain 1, request is for chain 137/)
})

test('walletAdapterFromEip1193 calls wallet_switchEthereumChain when onChainMismatch: "switch"', async () => {
  let switchedTo: string | null = null
  const adapter = walletAdapterFromEip1193({
    provider: mockProvider({
      chainId: '0x1',
      onSwitch: (chainId) => {
        switchedTo = chainId
      },
    }),
    account: FAKE_ADDRESS,
    onChainMismatch: 'switch',
  })

  const hash = await adapter.sendTransaction({
    to: ('0x' + 'b'.repeat(40)) as Hex,
    data: '0x',
    value: 0n,
    chainId: 137,
  })

  expect(switchedTo).toBe('0x89') // 137 in hex
  expect(hash).toBe(FAKE_TX_HASH)
})
