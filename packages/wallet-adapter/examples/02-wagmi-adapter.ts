/**
 * 02 — wagmi → `WalletAdapter`.
 *
 * The most common React stack. Wagmi's `useWalletClient()` hook
 * returns a viem `WalletClient` once the user is connected; the
 * bridge to `WalletAdapter` is a thin wrapper that maps the adapter's
 * neutral request shape onto `walletClient.sendTransaction`.
 *
 * Internally wagmi sits on top of the same EIP-1193 providers that
 * `01-reown-adapter.ts` shows the universal bridge for — when you
 * configure wagmi with the Reown / WalletConnect connector, you ARE
 * using EIP-1193 underneath. So why a separate example? Because in
 * React code, you typically already have a `useWalletClient()`-shaped
 * value in hand (from connection state your component already reads),
 * and asking developers to round-trip through `getProvider() →
 * createWalletClient()` is unnecessary work.
 *
 * Wagmi plumbing (omitted so the file typechecks without `wagmi`
 * installed):
 *
 *   import { useAccount, useWalletClient } from 'wagmi'
 *   import { walletAdapterFromWalletClient } from './02-wagmi-adapter.js'
 *
 *   function useMyAdapter(): WalletAdapter | null {
 *     const { address } = useAccount()
 *     const { data: walletClient } = useWalletClient()
 *     return useMemo(
 *       () => (walletClient && address)
 *         ? walletAdapterFromWalletClient(walletClient, address)
 *         : null,
 *       [walletClient, address],
 *     )
 *   }
 *
 * Pass `adapter` to any SDK that takes a `WalletAdapter`. The same
 * helper works for any code path that produces a viem `WalletClient`
 * directly — wagmi, ethers v6 + viem-adapters/ethers-adapters, custom
 * connection layers — not just wagmi.
 *
 * Run with: `yarn tsx examples/02-wagmi-adapter.ts`. The script ends
 * with a no-network sanity check using a fake transport.
 */

import { createWalletClient, custom, type Hex, type WalletClient } from 'viem'
import { mainnet } from 'viem/chains'

import type {
  WalletAdapter,
  WalletSendTransactionRequest,
} from '../src/index.js'

/* -------------------------------------------------------------------------- */
/*  The bridge                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Wrap a viem `WalletClient` + connected account as a `WalletAdapter`.
 *
 * Chain-mismatch handling here is simpler than the EIP-1193 case
 * because a `WalletClient` carries its own `.chain` — wagmi already
 * routes transactions to the wallet's connected chain via its own
 * `switchChain` flow. We still defensively check `request.chainId`
 * against `walletClient.chain?.id` and throw on mismatch, since
 * `WalletAdapter`'s contract requires it. Consumers who want
 * automatic chain switching should call wagmi's `useSwitchChain()`
 * before calling the SDK that uses the adapter.
 */
export const walletAdapterFromWalletClient = (
  walletClient: WalletClient,
  account: Hex,
): WalletAdapter => ({
  address: account,
  sendTransaction: async (
    request: WalletSendTransactionRequest,
  ): Promise<Hex> => {
    const walletChainId = walletClient.chain?.id
    if (walletChainId !== undefined && walletChainId !== request.chainId) {
      throw new Error(
        `WalletAdapter: walletClient is on chain ${walletChainId}, ` +
          `request is for chain ${request.chainId}. Switch via ` +
          `wagmi's useSwitchChain() before calling the SDK.`,
      )
    }
    return walletClient.sendTransaction({
      account,
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

const account = ('0x' + 'a'.repeat(40)) as Hex

// Build a fake EIP-1193-shaped transport via viem's `custom`. Returns
// canned values for the methods viem's WalletClient invokes during a
// sendTransaction (chainId probe, account discovery, gas estimation,
// and the send itself) — enough surface to exercise the bridge
// end-to-end without a real RPC.
const fakeWalletClient: WalletClient = createWalletClient({
  account,
  chain: mainnet,
  transport: custom({
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_accounts') return [account]
      if (method === 'eth_getTransactionCount') return '0x0'
      if (method === 'eth_estimateGas') return '0x5208'
      if (method === 'eth_gasPrice') return '0x77359400'
      if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00'
      if (method === 'eth_sendTransaction') return '0xfeedface'.padEnd(66, '0')
      throw new Error(`fake walletClient: unexpected method ${method}`)
    },
  }),
})

const adapter = walletAdapterFromWalletClient(fakeWalletClient, account)

const hash = await adapter.sendTransaction({
  to: ('0x' + 'b'.repeat(40)) as Hex,
  data: '0x',
  value: 0n,
  chainId: 1,
})

console.log('Sanity check: wagmi-style adapter returned hash', hash)
