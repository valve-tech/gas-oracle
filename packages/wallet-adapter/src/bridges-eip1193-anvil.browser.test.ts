/**
 * Browser-mode integration test: `walletAdapterFromEip1193`
 * (examples/01-reown-adapter.ts) against a real anvil chain.
 *
 * The browser test page constructs an EIP-1193 provider that proxies
 * to anvil over HTTP — anvil is what consumers' wallet apps would
 * be talking to in production, just exposed as a raw RPC endpoint
 * rather than wrapped in WalletConnect's transport layer. The
 * bridge code path is identical: build a viem `WalletClient` over
 * `custom(provider)`, sign with the EIP-1193 provider's
 * `eth_sendTransaction`, broadcast.
 *
 * Anvil holds the private keys for its 10 test accounts and signs
 * `eth_sendTransaction` requests itself — exactly like a remote
 * wallet (MetaMask, etc.) does. This is the closest we can get to
 * "real wallet, real chain" in a CI-safe environment.
 *
 * Anvil is spawned by `vitest.browser.globalsetup.ts` (Node-side)
 * and the URL is injected here via `inject('anvilUrl')`.
 */
import { expect, inject, test } from 'vitest'

import type { EIP1193Provider, Hex } from 'viem'
import { createPublicClient, http, parseEther } from 'viem'

import { ANVIL_ACCOUNTS } from './anvil-accounts.js'

import { walletAdapterFromEip1193 } from '../examples/01-reown-adapter.js'

const anvilUrl = inject('anvilUrl')

/**
 * Wrap anvil's HTTP RPC as an EIP-1193 provider. Same shape as
 * what `window.ethereum` / Reown's `appKit.getProvider('eip155')`
 * surfaces — `.request({ method, params })` over JSON-RPC.
 */
const eip1193OverHttp = (url: string): EIP1193Provider => ({
  request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: params ?? [],
      }),
    })
    const json = (await res.json()) as { result?: unknown; error?: { message: string } }
    if (json.error) throw new Error(json.error.message)
    return json.result
  },
}) as unknown as EIP1193Provider

test('walletAdapterFromEip1193 broadcasts a real tx through anvil in a real browser', async () => {
  const provider = eip1193OverHttp(anvilUrl)
  const adapter = walletAdapterFromEip1193({
    provider,
    account: ANVIL_ACCOUNTS.relayer.address as Hex,
  })

  const hash = await adapter.sendTransaction({
    to: ANVIL_ACCOUNTS.recipient.address as Hex,
    data: '0x',
    value: parseEther('0.1'),
    chainId: 31337,
  })

  expect(hash).toMatch(/^0x[0-9a-fA-F]{64}$/)

  // Verify the tx mined.
  const publicClient = createPublicClient({ transport: http(anvilUrl) })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  expect(receipt.status).toBe('success')
  expect(receipt.from.toLowerCase()).toBe(
    ANVIL_ACCOUNTS.relayer.address.toLowerCase(),
  )
})

test('walletAdapterFromEip1193 chain-mismatch fail-fast works in browser', async () => {
  const provider = eip1193OverHttp(anvilUrl)
  const adapter = walletAdapterFromEip1193({
    provider,
    account: ANVIL_ACCOUNTS.relayer.address as Hex,
  })

  await expect(
    adapter.sendTransaction({
      to: ANVIL_ACCOUNTS.recipient.address as Hex,
      data: '0x',
      value: 0n,
      chainId: 1, // mainnet — anvil is 31337
    }),
  ).rejects.toThrow(/wallet is on chain 31337, request is for chain 1/)
})
