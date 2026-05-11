/**
 * Browser-mode integration test: `walletAdapterFromWalletClient`
 * (examples/02-wagmi-adapter.ts) against a real anvil chain.
 *
 * In a real wagmi React app, `useWalletClient()` returns a viem
 * `WalletClient` that internally wraps the connected wallet's
 * EIP-1193 provider (MetaMask, WalletConnect, etc.). For this
 * test the wallet "is" anvil — we construct a WalletClient with a
 * `privateKeyToAccount` signer and an `http` transport pointed at
 * anvil. Same `walletClient.sendTransaction` API, real chain
 * underneath.
 *
 * Anvil is spawned by `vitest.browser.globalsetup.ts` (Node-side)
 * and the URL is injected here via `inject('anvilUrl')`.
 */
import { expect, inject, test } from 'vitest'

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Chain,
  type Hex,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { ANVIL_ACCOUNTS } from './anvil-accounts.js'

import { walletAdapterFromWalletClient } from '../examples/02-wagmi-adapter.js'

const anvilUrl = inject('anvilUrl')

// Anvil's chain — minimal viem Chain shape pointed at the local RPC.
const anvilChain: Chain = {
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['placeholder'] },
  },
}

test('walletAdapterFromWalletClient broadcasts via a real viem WalletClient + anvil (wagmi shape)', async () => {
  const account = privateKeyToAccount(ANVIL_ACCOUNTS.relayer.privateKey as Hex)
  const walletClient: WalletClient = createWalletClient({
    account,
    chain: anvilChain,
    transport: http(anvilUrl),
  }) as unknown as WalletClient

  const adapter = walletAdapterFromWalletClient(
    walletClient,
    ANVIL_ACCOUNTS.relayer.address as Hex,
  )

  const hash = await adapter.sendTransaction({
    to: ANVIL_ACCOUNTS.recipient.address as Hex,
    data: '0x',
    value: parseEther('0.25'),
    chainId: 31337,
  })

  expect(hash).toMatch(/^0x[0-9a-fA-F]{64}$/)

  const publicClient = createPublicClient({ transport: http(anvilUrl) })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  expect(receipt.status).toBe('success')
  expect(receipt.from.toLowerCase()).toBe(
    ANVIL_ACCOUNTS.relayer.address.toLowerCase(),
  )
})

test('walletAdapterFromWalletClient cross-chain check fires in browser', async () => {
  const account = privateKeyToAccount(ANVIL_ACCOUNTS.relayer.privateKey as Hex)
  const walletClient: WalletClient = createWalletClient({
    account,
    chain: anvilChain,
    transport: http(anvilUrl),
  }) as unknown as WalletClient

  const adapter = walletAdapterFromWalletClient(
    walletClient,
    ANVIL_ACCOUNTS.relayer.address as Hex,
  )

  await expect(
    adapter.sendTransaction({
      to: ANVIL_ACCOUNTS.recipient.address as Hex,
      data: '0x',
      value: 0n,
      chainId: 1, // walletClient.chain is anvilChain (id=31337)
    }),
  ).rejects.toThrow(/walletClient is on chain 31337, request is for chain 1/)
})
