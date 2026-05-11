/**
 * Real-chain integration test for `walletAdapterFromRelayer` (from
 * `examples/03-server-relayer.ts`).
 *
 * Starts anvil via prool, builds the bridge against it, signs a real
 * tx with one of anvil's pre-funded test accounts, broadcasts, and
 * verifies the receipt landed. Catches anything the Node-side
 * fake-stub sanity check at the bottom of the example would miss —
 * actual transaction signing, EIP-155 chain validation, gas
 * estimation roundtrips, receipt polling, the lot.
 *
 * This is a Node-only test (anvil is a native subprocess); for
 * browser parity see `bridges-eip1193-anvil.browser.test.ts`.
 */
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createPublicClient, http, parseEther, type Hex } from 'viem'

import { ANVIL_ACCOUNTS, createAnvilFixture } from './anvil-fixture.js'

import { walletAdapterFromRelayer } from '../examples/03-server-relayer.js'

const anvil = createAnvilFixture(8745)

beforeAll(async () => {
  await anvil.start()
}, 30_000)

afterAll(async () => {
  await anvil.stop()
})

test('walletAdapterFromRelayer signs + broadcasts a real transaction on anvil', async () => {
  const adapter = walletAdapterFromRelayer({
    privateKey: ANVIL_ACCOUNTS.relayer.privateKey as Hex,
    rpcUrl: anvil.url,
    chainId: 31337, // anvil's default chainId
  })

  expect(adapter.address.toLowerCase()).toBe(
    ANVIL_ACCOUNTS.relayer.address.toLowerCase(),
  )

  const hash = await adapter.sendTransaction({
    to: ANVIL_ACCOUNTS.recipient.address as Hex,
    data: '0x',
    value: parseEther('1.5'),
    chainId: 31337,
  })

  expect(hash).toMatch(/^0x[0-9a-fA-F]{64}$/)

  // Verify the tx actually landed: poll the receipt and check
  // recipient balance moved.
  const publicClient = createPublicClient({ transport: http(anvil.url) })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  expect(receipt.status).toBe('success')
  expect(receipt.from.toLowerCase()).toBe(
    ANVIL_ACCOUNTS.relayer.address.toLowerCase(),
  )
  expect(receipt.to?.toLowerCase()).toBe(
    ANVIL_ACCOUNTS.recipient.address.toLowerCase(),
  )

  const recipientBalance = await publicClient.getBalance({
    address: ANVIL_ACCOUNTS.recipient.address as Hex,
  })
  // Recipient started with 10_000 ETH + 1.5 = 10001.5 ETH
  expect(recipientBalance).toBe(parseEther('10001.5'))
})

test('walletAdapterFromRelayer rejects cross-chain requests at the adapter level', async () => {
  const adapter = walletAdapterFromRelayer({
    privateKey: ANVIL_ACCOUNTS.relayer.privateKey as Hex,
    rpcUrl: anvil.url,
    chainId: 31337,
  })

  await expect(
    adapter.sendTransaction({
      to: ANVIL_ACCOUNTS.recipient.address as Hex,
      data: '0x',
      value: 0n,
      chainId: 1, // mainnet — relayer is bound to 31337
    }),
  ).rejects.toThrow(/Relayer is bound to chain 31337.*chain 1/)
})
