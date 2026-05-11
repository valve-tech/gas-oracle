/**
 * 07 — Privy embedded wallet → `WalletAdapter`.
 *
 * Privy hosts an embedded wallet for each authenticated user (no
 * extension, no QR code, no seed-phrase UX) and surfaces it through
 * the `usePrivy()` / `useWallets()` hooks in `@privy-io/react-auth`.
 * The embedded wallet exposes an EIP-1193 provider via
 * `wallet.getEthereumProvider()`, which means the bridge is mostly
 * the same shape as example 01 — but Privy's specifics around
 * authentication state and wallet selection are worth surfacing for
 * consumers building on Privy.
 *
 * Things to know:
 *
 * - **The wallet may not be ready immediately.** `useWallets()`
 *   returns `{ wallets, ready }`; the bridge should be constructed
 *   only after `ready === true`, otherwise `getEthereumProvider()`
 *   throws.
 * - **One user can have multiple wallets.** A user might have the
 *   embedded wallet AND a linked external wallet (MetaMask, etc.).
 *   The dapp picks which one to bridge — typically the embedded
 *   one, filtered by `walletClientType === 'privy'`.
 * - **Embedded wallets sign without a confirmation UI by default.**
 *   For higher-value txs, Privy supports a confirmation modal via
 *   `useFundWallet()` / `sendTransaction()` from `usePrivy()` —
 *   that goes through Privy's UI, not the EIP-1193 path. This
 *   bridge uses the raw EIP-1193 provider; consumers wanting the
 *   UI flow should bypass it.
 *
 * Plumbing (omitted so the file typechecks without `@privy-io/react-auth`
 * installed):
 *
 *   import { usePrivy, useWallets } from '@privy-io/react-auth'
 *   import { walletAdapterFromPrivyWallet } from './07-privy-embedded.js'
 *
 *   function useMyAdapter(): WalletAdapter | null {
 *     const { wallets, ready } = useWallets()
 *     const embedded = wallets.find(w => w.walletClientType === 'privy')
 *     if (!ready || !embedded) return null
 *     return walletAdapterFromPrivyWallet(embedded)
 *   }
 *
 * Run with: `yarn tsx examples/07-privy-embedded.ts`. The sanity
 * check uses a fake `PrivyWallet`.
 */

import { createWalletClient, custom, type Hex, type WalletClient } from 'viem'
import { mainnet } from 'viem/chains'

import type {
  WalletAdapter,
  WalletSendTransactionRequest,
} from '../src/index.js'

/* -------------------------------------------------------------------------- */
/*  Minimal type stub (mirrors @privy-io/react-auth's ConnectedWallet)        */
/* -------------------------------------------------------------------------- */

/**
 * The minimal Privy `ConnectedWallet` surface this bridge needs.
 * Real consumers pass the wallet object returned by Privy's
 * `useWallets()` hook; we type only the methods we touch.
 */
interface MinimalPrivyWallet {
  address: string
  chainId: string // Privy uses CAIP-2 format: `eip155:<chainId>`
  walletClientType: string // 'privy' for embedded, 'metamask' for external, etc.
  /**
   * Returns the EIP-1193 provider for this wallet. Throws if the
   * wallet isn't ready (e.g. user not authenticated yet, embedded
   * wallet not yet provisioned).
   */
  getEthereumProvider(): Promise<{
    request(args: { method: string; params?: unknown[] }): Promise<unknown>
  }>
}

/* -------------------------------------------------------------------------- */
/*  The bridge                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parse a CAIP-2 chain id string (`eip155:1`) into its EVM chain
 * number (`1`). Used to compare against the request's chainId.
 */
const parseCaip2 = (caip2: string): number => {
  const [namespace, id] = caip2.split(':')
  if (namespace !== 'eip155' || !id) {
    throw new Error(
      `Privy wallet chainId is not EVM CAIP-2 format: ${caip2}`,
    )
  }
  return Number.parseInt(id, 10)
}

/**
 * Wrap a Privy `ConnectedWallet` as a `WalletAdapter`. The wallet's
 * EIP-1193 provider is fetched lazily on each `sendTransaction`
 * call (Privy can swap the provider when the user switches wallets
 * mid-session, so caching the provider isn't safe).
 *
 * Chain-mismatch handling: if the wallet's CAIP-2 chainId doesn't
 * match the request's, throw. Consumers wanting automatic switching
 * should call Privy's `wallet.switchChain(...)` before invoking the
 * adapter — embedded wallets switch silently, external wallets
 * prompt.
 */
export const walletAdapterFromPrivyWallet = (
  wallet: MinimalPrivyWallet,
): WalletAdapter => ({
  address: wallet.address as Hex,
  sendTransaction: async (
    request: WalletSendTransactionRequest,
  ): Promise<Hex> => {
    const walletChainId = parseCaip2(wallet.chainId)
    if (walletChainId !== request.chainId) {
      throw new Error(
        `WalletAdapter: Privy wallet is on chain ${walletChainId} ` +
          `(CAIP-2 ${wallet.chainId}), request is for chain ${request.chainId}. ` +
          `Call wallet.switchChain('eip155:${request.chainId}') first.`,
      )
    }
    const provider = await wallet.getEthereumProvider()
    const walletClient: WalletClient = createWalletClient({
      account: wallet.address as Hex,
      chain: mainnet,
      transport: custom(provider),
    })
    return walletClient.sendTransaction({
      account: wallet.address as Hex,
      to: request.to,
      data: request.data,
      value: request.value ?? 0n,
      chain: null,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    })
  },
})

/* -------------------------------------------------------------------------- */
/*  Sanity check (no network)                                                 */
/* -------------------------------------------------------------------------- */

const FAKE_ADDRESS = ('0x' + 'a'.repeat(40)) as Hex

const fakePrivyWallet: MinimalPrivyWallet = {
  address: FAKE_ADDRESS,
  chainId: 'eip155:1',
  walletClientType: 'privy',
  getEthereumProvider: async () => ({
    request: async ({ method }) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_accounts') return [FAKE_ADDRESS]
      if (method === 'eth_getTransactionCount') return '0x0'
      if (method === 'eth_estimateGas') return '0x5208'
      if (method === 'eth_gasPrice') return '0x77359400'
      if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00'
      if (method === 'eth_sendTransaction') return '0xprivy'.padEnd(66, '0')
      throw new Error(`fake privy provider: unexpected method ${method}`)
    },
  }),
}

const adapter = walletAdapterFromPrivyWallet(fakePrivyWallet)

const hash = await adapter.sendTransaction({
  to: ('0x' + 'b'.repeat(40)) as Hex,
  data: '0x',
  value: 0n,
  chainId: 1,
})

console.log('Sanity check: Privy adapter returned hash', hash)

let crossChainError: unknown = null
try {
  await adapter.sendTransaction({
    to: ('0x' + 'b'.repeat(40)) as Hex,
    data: '0x',
    value: 0n,
    chainId: 137,
  })
} catch (err) {
  crossChainError = err
}
console.log('Sanity check: cross-chain rejected with:', (crossChainError as Error).message)
