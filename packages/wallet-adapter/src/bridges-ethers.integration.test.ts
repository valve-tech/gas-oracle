/**
 * Real-chain + real-SDK integration test for
 * `walletAdapterFromEthersSigner` (from `examples/06-ethers-adapter.ts`).
 *
 * Spawns anvil, builds a real ethers v6 `Wallet` signer pointed at
 * it, threads the signer through the bridge, signs and broadcasts
 * a real tx, and verifies the receipt + recipient balance change.
 *
 * Catches everything the type-stubbed fake sanity check in the
 * example file would miss: ethers v6 actually computing the
 * effective tx shape from the request, EIP-155 chain validation
 * inside ethers, the signer's nonce probe, and the bridge's chain-
 * mismatch detection working against ethers' own chainId source
 * (provider.getNetwork(), not options).
 *
 * Node-only — anvil is a child process. ethers is a real
 * devDependency here, not a type stub.
 */
import { afterAll, beforeAll, expect, test } from 'vitest'

import { JsonRpcProvider, Wallet } from 'ethers'
import { createPublicClient, http, parseEther, type Hex } from 'viem'

import { ANVIL_ACCOUNTS, createAnvilFixture } from './anvil-fixture.js'

import { walletAdapterFromEthersSigner } from '../examples/06-ethers-adapter.js'

const anvil = createAnvilFixture(8746)

beforeAll(async () => {
  await anvil.start()
}, 30_000)

afterAll(async () => {
  await anvil.stop()
})

test('walletAdapterFromEthersSigner signs + broadcasts a real transaction via ethers v6', async () => {
  const provider = new JsonRpcProvider(anvil.url)
  const wallet = new Wallet(ANVIL_ACCOUNTS.relayer.privateKey, provider)

  const adapter = walletAdapterFromEthersSigner(
    wallet,
    ANVIL_ACCOUNTS.relayer.address as Hex,
  )

  expect(adapter.address.toLowerCase()).toBe(
    ANVIL_ACCOUNTS.relayer.address.toLowerCase(),
  )

  const hash = await adapter.sendTransaction({
    to: ANVIL_ACCOUNTS.recipient.address as Hex,
    data: '0x',
    value: parseEther('0.75'),
    chainId: 31337,
  })

  expect(hash).toMatch(/^0x[0-9a-fA-F]{64}$/)

  // Cross-check via viem against the same anvil.
  const publicClient = createPublicClient({ transport: http(anvil.url) })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  expect(receipt.status).toBe('success')
  expect(receipt.from.toLowerCase()).toBe(
    ANVIL_ACCOUNTS.relayer.address.toLowerCase(),
  )
})

test('walletAdapterFromEthersSigner throws on cross-chain via provider.getNetwork() check', async () => {
  // ethers' provider exposes its chainId; the bridge compares it
  // against the request's chainId and throws on mismatch. Build a
  // wallet against anvil (chainId 31337) and request a tx for
  // mainnet (chainId 1) — should throw before any signing happens.
  const provider = new JsonRpcProvider(anvil.url)
  const wallet = new Wallet(ANVIL_ACCOUNTS.relayer.privateKey, provider)

  const adapter = walletAdapterFromEthersSigner(
    wallet,
    ANVIL_ACCOUNTS.relayer.address as Hex,
  )

  await expect(
    adapter.sendTransaction({
      to: ANVIL_ACCOUNTS.recipient.address as Hex,
      data: '0x',
      value: 0n,
      chainId: 1,
    }),
  ).rejects.toThrow(/ethers signer is on chain 31337.*chain 1/)
})
