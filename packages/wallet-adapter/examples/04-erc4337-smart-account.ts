/**
 * 04 — EIP-4337 smart account → `WalletAdapter`.
 *
 * Account abstraction. Unlike EOAs, smart accounts don't sign
 * transactions directly — they sign UserOperations that get bundled
 * by an ERC-4337 bundler and executed on-chain via the EntryPoint
 * contract. The dapp side still wants to think in terms of "send a
 * transaction and get a hash back," so the bridge translates:
 *
 *   WalletAdapter.sendTransaction({ to, data, value, chainId, ... })
 *     ↓ build UserOperation { sender = smart account, callData = encoded
 *       (to, value, data) call to smart account's execute(), nonce,
 *       gas limits, signature }
 *     ↓ submit to bundler via eth_sendUserOperation
 *     ↓ bundler returns userOpHash
 *     ↓ wait for receipt via eth_getUserOperationReceipt
 *     ↓ return the actual on-chain tx hash
 *
 * Address semantics: `WalletAdapter.address` is the smart-account
 * address, NOT the EOA signer that controls it. Consumers should
 * always use `adapter.address` when displaying "the user's wallet
 * address" — the EOA signer is implementation detail and may be
 * absent entirely (passkey-controlled accounts, multi-sig accounts).
 *
 * Wait semantics: `sendTransaction` here is NOT the same shape as
 * EOA send. It can take 1–10× longer because it waits for the
 * bundler to include the UserOp in a transaction and for that
 * transaction to mine. SDKs that expect sub-second send-and-return
 * should know they'll get bundler-timing latency here.
 *
 * Plumbing (omitted so the file typechecks without permissionless.js
 * installed):
 *
 *   import { createSmartAccountClient } from 'permissionless'
 *   import { toSafeSmartAccount } from 'permissionless/accounts'
 *   import { createPublicClient, http } from 'viem'
 *
 *   const publicClient = createPublicClient({ chain: mainnet, transport: http() })
 *   const safeAccount  = await toSafeSmartAccount({
 *     client: publicClient,
 *     owners: [eoaAccount],   // viem PrivateKeyAccount or viem WalletClient.account
 *     version: '1.4.1',
 *   })
 *   const smartAccountClient = createSmartAccountClient({
 *     account: safeAccount,
 *     chain: mainnet,
 *     bundlerTransport: http(BUNDLER_URL),
 *   })
 *
 *   const adapter = walletAdapterFromSmartAccount(smartAccountClient)
 *
 * The `SmartAccountClient` shape is what permissionless.js's
 * `createSmartAccountClient` returns. We type-stub the minimal
 * surface here so the file typechecks without the SDK installed —
 * real consumers should import the real type from permissionless.
 *
 * Run with: `yarn tsx examples/04-erc4337-smart-account.ts`. The
 * sanity check at the bottom uses a fake client.
 */

import type { Hex } from 'viem'

import type {
  WalletAdapter,
  WalletSendTransactionRequest,
} from '../src/index.js'

/* -------------------------------------------------------------------------- */
/*  Minimal type stub (mirrors permissionless's SmartAccountClient surface)   */
/* -------------------------------------------------------------------------- */

/**
 * The minimal shape of a permissionless.js / similar smart-account
 * client that this bridge needs. Real consumers will pass the full
 * `SmartAccountClient<...>` from permissionless; we type only the
 * surface we touch.
 */
interface MinimalSmartAccountClient {
  account: { address: Hex }
  chain: { id: number } | undefined
  /**
   * Send a UserOperation built from the given calls, wait for the
   * bundler to include it on-chain, return the resulting tx hash.
   * permissionless.js exposes this as `sendTransaction(args)` on the
   * smart-account client, with a wait-for-inclusion semantics
   * baked in.
   */
  sendTransaction: (args: {
    to: Hex
    data: Hex
    value: bigint
    maxFeePerGas?: bigint
    maxPriorityFeePerGas?: bigint
  }) => Promise<Hex>
}

/* -------------------------------------------------------------------------- */
/*  The bridge                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Wrap a smart-account client (e.g. from permissionless's
 * `createSmartAccountClient`) as a `WalletAdapter`.
 *
 * `adapter.address` returns the smart-account address (not the EOA
 * signer that controls it). This is the address that holds funds
 * and that contracts see as `msg.sender` — exactly what dapp UIs and
 * SDKs want when they say "the user's wallet address."
 */
export const walletAdapterFromSmartAccount = (
  smartAccountClient: MinimalSmartAccountClient,
): WalletAdapter => ({
  address: smartAccountClient.account.address,
  sendTransaction: async (
    request: WalletSendTransactionRequest,
  ): Promise<Hex> => {
    const clientChainId = smartAccountClient.chain?.id
    if (clientChainId !== undefined && clientChainId !== request.chainId) {
      throw new Error(
        `WalletAdapter: smart-account client is on chain ${clientChainId}, ` +
          `request is for chain ${request.chainId}. Construct a separate ` +
          `client per chain — smart accounts are deployed per-chain and ` +
          `the bundler URL is chain-specific.`,
      )
    }
    return smartAccountClient.sendTransaction({
      to: request.to,
      data: request.data,
      value: request.value ?? 0n,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    })
  },
})

/* -------------------------------------------------------------------------- */
/*  Sanity check (no network)                                                 */
/* -------------------------------------------------------------------------- */

const SMART_ACCOUNT_ADDRESS = ('0x' + 'a'.repeat(40)) as Hex
const FAKE_TX_HASH = ('0x' + 'd'.repeat(64)) as Hex

const fakeSmartAccountClient: MinimalSmartAccountClient = {
  account: { address: SMART_ACCOUNT_ADDRESS },
  chain: { id: 1 },
  sendTransaction: async () => FAKE_TX_HASH,
}

const adapter = walletAdapterFromSmartAccount(fakeSmartAccountClient)

const hash = await adapter.sendTransaction({
  to: ('0x' + 'b'.repeat(40)) as Hex,
  data: '0x',
  value: 0n,
  chainId: 1,
})

console.log('Sanity check: smart-account adapter returned hash', hash)
console.log('Sanity check: adapter.address is the smart account, not the EOA:', adapter.address)
