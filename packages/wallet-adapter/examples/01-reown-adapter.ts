/**
 * 01 — Reown (WalletConnect protocol) → `WalletAdapter`.
 *
 * Reown's `@reown/appkit` exposes the connected wallet through an
 * EIP-1193 provider (or a viem `WalletClient` if you're on the wagmi
 * adapter). This file shows the universal bridge — wrap the EIP-1193
 * provider with viem's `custom` transport, create a `WalletClient`,
 * then satisfy the framework-agnostic `WalletAdapter` contract on top.
 *
 * The same shape works for any modern wallet plumbing — MetaMask SDK,
 * RainbowKit, Privy, Dynamic, raw `window.ethereum` — anything that
 * surfaces an EIP-1193 provider. WalletConnect / Reown is the broadest
 * (covers 200+ wallet apps via QR connection), so the example uses it
 * by name; the helper at the bottom is provider-agnostic.
 *
 * Reown plumbing (omitted here so the file typechecks without
 * @reown/appkit installed):
 *
 *   import { createAppKit } from '@reown/appkit'
 *   import { mainnet, polygon } from '@reown/appkit/networks'
 *
 *   const appKit = createAppKit({
 *     adapters: [],                              // see Reown docs
 *     networks: [mainnet, polygon],
 *     projectId: process.env.REOWN_PROJECT_ID!,  // from cloud.reown.com
 *   })
 *
 *   // After the user connects:
 *   const provider = appKit.getProvider('eip155')
 *   const account  = appKit.getAddress() as `0x${string}`
 *   const adapter  = walletAdapterFromEip1193({ provider, account })
 *
 * Pass `adapter` to any SDK that takes a `WalletAdapter` (the whole
 * point of the package) — the SDK doesn't care that the underlying
 * wallet came from Reown vs wagmi vs MetaMask.
 *
 * Run with: `yarn tsx examples/01-reown-adapter.ts`. The script runs a
 * tiny sanity check at the bottom (no network — fakes the provider) so
 * the example self-validates that the bridge typechecks AND that the
 * shape of `sendTransaction` on a `WalletClient` matches what
 * `WalletAdapter.sendTransaction` returns.
 */

import {
  createWalletClient,
  custom,
  type EIP1193Provider,
  type Hex,
  type WalletClient,
} from 'viem'
import { mainnet } from 'viem/chains'

import type {
  WalletAdapter,
  WalletSendTransactionRequest,
} from '../src/index.js'

/* -------------------------------------------------------------------------- */
/*  The bridge                                                                */
/* -------------------------------------------------------------------------- */

interface BridgeOptions {
  /** EIP-1193 provider — what `appKit.getProvider('eip155')` returns. */
  provider: EIP1193Provider
  /** Connected account — `appKit.getAddress()`. */
  account: Hex
  /**
   * What to do when an SDK's send request specifies a `chainId` the
   * wallet isn't currently on. Default `'throw'`: fail loudly rather
   * than silently signing for the wrong network (per the WalletAdapter
   * contract). Pass `'switch'` to call `wallet_switchEthereumChain`
   * first — the wallet may prompt the user, which has UX cost.
   */
  onChainMismatch?: 'throw' | 'switch'
}

/**
 * Wrap an EIP-1193 provider + connected account as a `WalletAdapter`.
 *
 * The wallet client is constructed lazily inside `sendTransaction`
 * because it's bound to the connected account, and Reown can swap the
 * connected account between calls (account-switch in MetaMask, swapping
 * connected wallets via the modal). Re-deriving on each call keeps the
 * adapter resilient to that mid-session change without forcing the
 * dapp to reconstruct the adapter.
 */
export const walletAdapterFromEip1193 = (
  options: BridgeOptions,
): WalletAdapter => {
  const { provider, account, onChainMismatch = 'throw' } = options

  const send = async (
    request: WalletSendTransactionRequest,
  ): Promise<Hex> => {
    const currentChainHex = (await provider.request({
      method: 'eth_chainId',
    })) as string
    const currentChainId = Number.parseInt(currentChainHex, 16)

    if (currentChainId !== request.chainId) {
      if (onChainMismatch === 'throw') {
        throw new Error(
          `WalletAdapter: wallet is on chain ${currentChainId}, request is for chain ${request.chainId}. ` +
            `Switch the wallet first or construct the adapter with onChainMismatch: 'switch'.`,
        )
      }
      // 'switch' — ask the wallet to switch. The wallet may prompt and
      // may reject (user dismissal). We pass the rejection through; the
      // helper layer (sendTransactionWithHooks) will classify it.
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${request.chainId.toString(16)}` }],
      })
    }

    const wallet: WalletClient = createWalletClient({
      account,
      chain: mainnet,
      transport: custom(provider),
    })

    return wallet.sendTransaction({
      account,
      to: request.to,
      data: request.data,
      value: request.value ?? 0n,
      chain: null,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    })
  }

  return {
    address: account,
    sendTransaction: send,
  }
}

/* -------------------------------------------------------------------------- */
/*  Sanity check (no network — fakes the EIP-1193 provider)                   */
/* -------------------------------------------------------------------------- */

const fakeProvider: EIP1193Provider = {
  request: async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return '0x1' // mainnet
    if (method === 'eth_sendTransaction') return '0xdeadbeef'.padEnd(66, '0')
    if (method === 'eth_accounts') return ['0x' + 'a'.repeat(40)]
    throw new Error(`fake provider: unexpected method ${method}`)
  },
} as unknown as EIP1193Provider

const adapter = walletAdapterFromEip1193({
  provider: fakeProvider,
  account: ('0x' + 'a'.repeat(40)) as Hex,
})

const hash = await adapter.sendTransaction({
  to: ('0x' + 'b'.repeat(40)) as Hex,
  data: '0x',
  value: 1n,
  chainId: 1,
})

console.log('Sanity check: adapter returned hash', hash)
