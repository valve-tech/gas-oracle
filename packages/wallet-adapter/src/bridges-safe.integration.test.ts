/**
 * Integration test for `walletAdapterFromSafe` from
 * `examples/08-safe-multisig.ts`.
 *
 * **Mock-driven, not fully-real**: Safe's `@safe-global/protocol-kit`
 * fails its init validation against a local anvil that lacks
 * deployed Safe contracts (it walks every Safe-contract address
 * and rejects when the configured deployments aren't found at
 * those addresses on the target chain). Full real-protocol-kit
 * testing would require:
 *
 * - Anvil fork mode against a chain that has Safe deployed
 *   (depends on a third-party mainnet RPC; not CI-stable), OR
 * - Deploying the Safe contracts from `@safe-global/safe-deployments`
 *   bytecode to anvil before each test (substantial fixture
 *   investment for a wallet-bridge unit), OR
 * - Using protocol-kit's test utilities (which themselves bring in
 *   Safe contract deployments as a dependency).
 *
 * For this layer — verifying that the BRIDGE wires
 * protocol-kit's three methods + apiKit's one method correctly —
 * a typed mock with the exact protocol-kit response shapes is
 * sufficient. The mock returns real-shape values (a 32-byte
 * safeTxHash, a 65-byte EIP-712 signature) so the test exercises
 * the same propagation paths the bridge will run against a real
 * Safe. The protocol-kit SDK itself is independently tested by
 * @safe-global; this file tests the bridge that wraps it.
 *
 * Filed under `.integration.test.ts` (not `.test.ts`) so it stays
 * out of the default unit suite; runs via `yarn test:integration`
 * alongside the real-anvil tests for the other bridges.
 */
import { expect, test } from 'vitest'

import { type Hex } from 'viem'

import { walletAdapterFromSafe } from '../examples/08-safe-multisig.js'

const SAFE_ADDRESS = '0x1234567890123456789012345678901234567890' as Hex
const SIGNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Hex
const REAL_SHAPE_SAFE_TX_HASH =
  '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' as Hex
// Real-shape ECDSA signature: 32-byte r + 32-byte s + 1-byte v.
const REAL_SHAPE_SIGNATURE =
  '0x' +
  'aa'.repeat(32) + // r
  'bb'.repeat(32) + // s
  '1c' // v = 28

test('walletAdapterFromSafe wires protocol-kit + api-kit calls in order', async () => {
  const calls: string[] = []

  const protocolKit = {
    createTransaction: async (args: {
      transactions: { to: string; data: string; value: string }[]
    }) => {
      calls.push('createTransaction')
      return { data: { ...args.transactions[0], nonce: 7 } }
    },
    getTransactionHash: async () => {
      calls.push('getTransactionHash')
      return REAL_SHAPE_SAFE_TX_HASH
    },
    signHash: async (safeTxHash: string) => {
      calls.push(`signHash(${safeTxHash})`)
      return { data: REAL_SHAPE_SIGNATURE }
    },
  }

  let proposalArgs: {
    safeAddress: string
    safeTxHash: string
    senderAddress: string
    senderSignature: string
  } | null = null
  const apiKit = {
    proposeTransaction: async (args: {
      safeAddress: string
      safeTransactionData: unknown
      safeTxHash: string
      senderAddress: string
      senderSignature: string
    }): Promise<void> => {
      calls.push('apiKit.proposeTransaction')
      proposalArgs = {
        safeAddress: args.safeAddress,
        safeTxHash: args.safeTxHash,
        senderAddress: args.senderAddress,
        senderSignature: args.senderSignature,
      }
    },
  }

  const adapter = walletAdapterFromSafe({
    protocolKit,
    apiKit,
    safeAddress: SAFE_ADDRESS,
    signerAddress: SIGNER_ADDRESS,
    chainId: 31337,
  })

  expect(adapter.address).toBe(SAFE_ADDRESS)

  const safeTxHash = await adapter.sendTransaction({
    to: '0x9999999999999999999999999999999999999999',
    data: '0xdeadbeef',
    value: 100n,
    chainId: 31337,
  })

  expect(safeTxHash).toBe(REAL_SHAPE_SAFE_TX_HASH)
  // Verify call order: createTransaction → getTransactionHash →
  // signHash → apiKit.proposeTransaction.
  expect(calls).toEqual([
    'createTransaction',
    'getTransactionHash',
    `signHash(${REAL_SHAPE_SAFE_TX_HASH})`,
    'apiKit.proposeTransaction',
  ])
  expect(proposalArgs).toEqual({
    safeAddress: SAFE_ADDRESS,
    safeTxHash: REAL_SHAPE_SAFE_TX_HASH,
    senderAddress: SIGNER_ADDRESS,
    senderSignature: REAL_SHAPE_SIGNATURE,
  })
})

test('walletAdapterFromSafe propagates createTransaction args from the WalletAdapter request', async () => {
  let capturedTx: { to: string; data: string; value: string } | null = null
  const protocolKit = {
    createTransaction: async (args: {
      transactions: { to: string; data: string; value: string }[]
    }) => {
      capturedTx = args.transactions[0]
      return { data: { ...args.transactions[0], nonce: 0 } }
    },
    getTransactionHash: async () => REAL_SHAPE_SAFE_TX_HASH,
    signHash: async () => ({ data: REAL_SHAPE_SIGNATURE }),
  }
  const apiKit = { proposeTransaction: async (): Promise<void> => {} }

  const adapter = walletAdapterFromSafe({
    protocolKit,
    apiKit,
    safeAddress: SAFE_ADDRESS,
    signerAddress: SIGNER_ADDRESS,
    chainId: 31337,
  })

  await adapter.sendTransaction({
    to: '0xabcdef0123456789abcdef0123456789abcdef01',
    data: '0xfeedface',
    value: 12345n,
    chainId: 31337,
  })

  expect(capturedTx).toEqual({
    to: '0xabcdef0123456789abcdef0123456789abcdef01',
    data: '0xfeedface',
    value: '12345', // Safe SDK expects value as a decimal string
  })
})

test('walletAdapterFromSafe rejects cross-chain requests before touching protocol-kit', async () => {
  let createCalls = 0
  const protocolKit = {
    createTransaction: async () => {
      createCalls += 1
      return { data: { to: '', data: '', value: '0', nonce: 0 } }
    },
    getTransactionHash: async () => REAL_SHAPE_SAFE_TX_HASH,
    signHash: async () => ({ data: REAL_SHAPE_SIGNATURE }),
  }
  const apiKit = { proposeTransaction: async (): Promise<void> => {} }

  const adapter = walletAdapterFromSafe({
    protocolKit,
    apiKit,
    safeAddress: SAFE_ADDRESS,
    signerAddress: SIGNER_ADDRESS,
    chainId: 31337,
  })

  await expect(
    adapter.sendTransaction({
      to: '0xabcdef0123456789abcdef0123456789abcdef01',
      data: '0x',
      value: 0n,
      chainId: 1, // mainnet — adapter bound to 31337
    }),
  ).rejects.toThrow(/Safe adapter is bound to chain 31337.*chain 1/)
  // The bridge MUST hard-fail before reaching protocol-kit.
  expect(createCalls).toBe(0)
})
