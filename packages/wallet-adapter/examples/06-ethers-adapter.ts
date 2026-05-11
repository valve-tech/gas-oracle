/**
 * 06 — ethers v6 wallet → `WalletAdapter`.
 *
 * For dapps still on ethers v6 (or running both ethers and viem
 * side-by-side during a migration). Ethers' `Wallet` and `JsonRpcSigner`
 * both implement the same `Signer` surface; the bridge takes the
 * neutral request shape, translates to ethers' `TransactionRequest`,
 * calls `signer.sendTransaction(...)`, and returns the on-chain hash.
 *
 * The ethers-side mental model:
 * - `BrowserProvider(window.ethereum).getSigner()` → connected user
 *   wallet (MetaMask, etc.). Triggers a wallet prompt.
 * - `Wallet(privateKey, provider)` → server-side signing from a
 *   private key. No prompt. (Note: prefer example 03 for server-side
 *   relayers — it uses viem natively, which is the toolkit's peer
 *   dep. This example is for dapps that already have an ethers signer
 *   in scope and don't want to re-wire.)
 *
 * Plumbing (omitted so the file typechecks without `ethers`
 * installed):
 *
 *   import { BrowserProvider } from 'ethers'
 *   import { walletAdapterFromEthersSigner } from './06-ethers-adapter.js'
 *
 *   const provider = new BrowserProvider(window.ethereum)
 *   const signer   = await provider.getSigner()
 *   const adapter  = walletAdapterFromEthersSigner(signer, await signer.getAddress() as `0x${string}`)
 *
 *   // Pass `adapter` to any SDK that takes a `WalletAdapter`.
 *
 * Run with: `yarn tsx examples/06-ethers-adapter.ts`. The sanity
 * check uses a hand-built fake signer.
 */

import type { Hex } from 'viem'

import type {
  WalletAdapter,
  WalletSendTransactionRequest,
} from '../src/index.js'

/* -------------------------------------------------------------------------- */
/*  Minimal type stub (mirrors ethers v6's `Signer` surface we touch)         */
/* -------------------------------------------------------------------------- */

/**
 * The minimal ethers v6 `Signer` surface this bridge needs. Real
 * consumers pass an `import('ethers').Signer`; we type only the two
 * methods we call so the example typechecks without `ethers`
 * installed.
 */
interface MinimalEthersSigner {
  getAddress(): Promise<string>
  sendTransaction(tx: {
    to: string
    data?: string
    value?: bigint
    chainId?: number | bigint
    maxFeePerGas?: bigint
    maxPriorityFeePerGas?: bigint
  }): Promise<{ hash: string }>
  provider?: {
    getNetwork(): Promise<{ chainId: bigint | number }>
  } | null
}

/* -------------------------------------------------------------------------- */
/*  The bridge                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Wrap an ethers v6 signer as a `WalletAdapter`. The provided
 * `address` is the connected account — pass `await signer.getAddress()`
 * once at adapter-construction time rather than awaiting it on every
 * `sendTransaction` (the address doesn't change for the lifetime of
 * a signer instance).
 *
 * Chain-mismatch handling: ethers signers carry their own provider
 * and chainId. If the signer's chainId disagrees with the request's,
 * we throw — auto-switching is a wallet-side action that ethers v6
 * doesn't unify across providers, so consumers who want it should
 * call their wallet library's chain-switch flow before invoking the
 * adapter.
 */
export const walletAdapterFromEthersSigner = (
  signer: MinimalEthersSigner,
  address: Hex,
): WalletAdapter => ({
  address,
  sendTransaction: async (
    request: WalletSendTransactionRequest,
  ): Promise<Hex> => {
    if (signer.provider) {
      const network = await signer.provider.getNetwork()
      const signerChainId = Number(network.chainId)
      if (signerChainId !== request.chainId) {
        throw new Error(
          `WalletAdapter: ethers signer is on chain ${signerChainId}, ` +
            `request is for chain ${request.chainId}. Switch the wallet's ` +
            `network first; ethers v6 does not unify chain-switching across ` +
            `BrowserProvider / JsonRpcProvider / Wallet.`,
        )
      }
    }
    const sent = await signer.sendTransaction({
      to: request.to,
      data: request.data,
      value: request.value ?? 0n,
      chainId: request.chainId,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    })
    return sent.hash as Hex
  },
})

/* -------------------------------------------------------------------------- */
/*  Sanity check (no network)                                                 */
/* -------------------------------------------------------------------------- */

const FAKE_ADDRESS = ('0x' + 'a'.repeat(40)) as Hex
const FAKE_TX_HASH = ('0x' + 'e'.repeat(64)) as Hex

const fakeSigner: MinimalEthersSigner = {
  getAddress: async () => FAKE_ADDRESS,
  sendTransaction: async () => ({ hash: FAKE_TX_HASH }),
  provider: {
    getNetwork: async () => ({ chainId: 1n }),
  },
}

const adapter = walletAdapterFromEthersSigner(fakeSigner, FAKE_ADDRESS)

const hash = await adapter.sendTransaction({
  to: ('0x' + 'b'.repeat(40)) as Hex,
  data: '0x',
  value: 0n,
  chainId: 1,
})

console.log('Sanity check: ethers adapter returned hash', hash)

// Cross-chain hard-fail.
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
