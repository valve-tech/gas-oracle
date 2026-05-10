/**
 * 05 — Hardware wallet (direct USB/HID) → `WalletAdapter`.
 *
 * For the **direct-attached hardware wallet** case — backend code,
 * kiosk apps, dev tooling that talks to a Ledger via a USB/HID
 * transport without a wallet-app intermediary. Ledger Live, MetaMask
 * + Ledger, and WalletConnect-to-Ledger-Live all surface as standard
 * EIP-1193 providers — for those, use `01-reown-adapter.ts` instead.
 * This example is for the layer below.
 *
 * The bridge wraps `@ledgerhq/hw-app-eth` (Ledger's Ethereum app
 * helper) into a viem `LocalAccount`-shaped object, then constructs
 * a viem `WalletClient` from it. The `WalletAdapter` then sits on
 * the `WalletClient` exactly like example 02.
 *
 * The user's involvement is the same as any hardware wallet: every
 * `sendTransaction` triggers a confirmation prompt on the device.
 * The Promise returned by the adapter resolves only after the user
 * approves on-device, so the SDK's hooks (`onAwaitingSignature`,
 * `onTransactionHash`) fire at meaningful boundaries.
 *
 * Plumbing (omitted so the file typechecks without `@ledgerhq/*`
 * installed):
 *
 *   import TransportNodeHid from '@ledgerhq/hw-transport-node-hid'
 *   import Eth from '@ledgerhq/hw-app-eth'
 *   import { createWalletClient, http } from 'viem'
 *   import { walletAdapterFromLedger } from './05-hardware-wallet-direct.js'
 *
 *   const transport = await TransportNodeHid.create()
 *   const ledger    = new Eth(transport)
 *   const path      = "44'/60'/0'/0/0"   // BIP-44 derivation path
 *   const { address } = await ledger.getAddress(path)
 *
 *   const adapter = walletAdapterFromLedger({
 *     ledger,
 *     derivationPath: path,
 *     address: address as `0x${string}`,
 *     rpcUrl: 'https://mainnet.example.com',
 *     chainId: 1,
 *   })
 *
 * Web variant: replace `TransportNodeHid` with
 * `@ledgerhq/hw-transport-webhid` (browser) or
 * `@ledgerhq/hw-transport-webusb` (also browser; less common).
 *
 * Trezor: replace `Eth` with `@trezor/connect`'s `ethereumSignTransaction`
 * / `ethereumGetAddress`. The bridge shape is identical; the SDK
 * surface differs slightly. The same `WalletAdapter` end shape
 * applies.
 *
 * Run with: `yarn tsx examples/05-hardware-wallet-direct.ts`. The
 * sanity check uses a fake ledger object.
 */

import {
  createWalletClient,
  http,
  serializeTransaction,
  type Hash,
  type Hex,
  type LocalAccount,
  type SignableMessage,
  type SignTypedDataParameters,
  type TransactionSerializable,
  type TypedData,
} from 'viem'
import { mainnet } from 'viem/chains'

import type {
  WalletAdapter,
  WalletSendTransactionRequest,
} from '../src/index.js'

/* -------------------------------------------------------------------------- */
/*  Minimal type stub for @ledgerhq/hw-app-eth                                */
/* -------------------------------------------------------------------------- */

/**
 * The minimal shape of `@ledgerhq/hw-app-eth`'s `Eth` class that this
 * bridge needs. Real consumers import `Eth` from `@ledgerhq/hw-app-eth`
 * and pass an instance; we type only the methods we touch.
 */
interface MinimalLedgerEth {
  getAddress(
    path: string,
  ): Promise<{ publicKey: string; address: string }>
  signTransaction(
    path: string,
    rawTxHex: string,
  ): Promise<{ s: string; v: string; r: string }>
}

/* -------------------------------------------------------------------------- */
/*  The bridge                                                                */
/* -------------------------------------------------------------------------- */

interface LedgerAdapterOptions {
  ledger: MinimalLedgerEth
  /** BIP-44 derivation path. The standard EVM path is `"44'/60'/0'/0/0"`. */
  derivationPath: string
  /** The address Ledger returned for this derivation path (cache it). */
  address: Hex
  /** RPC URL the relayer signs against. */
  rpcUrl: string
  /** EVM chain id. */
  chainId: number
}

/**
 * Wrap a Ledger device + derivation path as a `WalletAdapter`. The
 * device prompts the user to confirm every sign — `sendTransaction`
 * returns only after on-device approval.
 *
 * Implementation outline: build a viem `LocalAccount` whose
 * `signTransaction` delegates to Ledger; wrap that with a
 * `WalletClient`; expose `WalletAdapter.sendTransaction` on top.
 * Message and typed-data signing throw — most dapps wanting hardware
 * wallets only need transaction signing, and the typed-data path on
 * Ledger requires a clear-signing plugin per contract that's its
 * own design problem.
 */
export const walletAdapterFromLedger = (
  options: LedgerAdapterOptions,
): WalletAdapter => {
  const { ledger, derivationPath, address, rpcUrl, chainId } = options

  const account: LocalAccount = {
    address,
    type: 'local',
    publicKey: '0x',
    source: 'ledger',
    signMessage: async (_args: { message: SignableMessage }): Promise<Hex> => {
      throw new Error(
        'Ledger adapter: signMessage not implemented. Use signTransaction only.',
      )
    },
    signTypedData: async <
      const TTypedData extends TypedData | Record<string, unknown>,
      TPrimaryType extends string,
    >(
      _args: SignTypedDataParameters<TTypedData, TPrimaryType>,
    ): Promise<Hex> => {
      throw new Error(
        'Ledger adapter: signTypedData not implemented (requires per-contract clear-signing plugin).',
      )
    },
    signTransaction: async (
      transaction: TransactionSerializable,
    ): Promise<Hex> => {
      const rawTxHex = serializeTransaction(transaction).slice(2)
      const sig = await ledger.signTransaction(derivationPath, rawTxHex)
      const v = BigInt('0x' + sig.v)
      return serializeTransaction(transaction, {
        r: ('0x' + sig.r) as Hex,
        s: ('0x' + sig.s) as Hex,
        v,
      })
    },
    nonceManager: undefined,
  } as unknown as LocalAccount

  const walletClient = createWalletClient({
    account,
    chain: { ...mainnet, id: chainId },
    transport: http(rpcUrl),
  })

  return {
    address,
    sendTransaction: async (
      request: WalletSendTransactionRequest,
    ): Promise<Hex> => {
      if (request.chainId !== chainId) {
        throw new Error(
          `Ledger adapter is bound to chain ${chainId}; got request for chain ${request.chainId}. ` +
            `Construct a separate adapter per chain.`,
        )
      }
      // viem will call `account.signTransaction`, which in turn calls
      // the Ledger device — the device prompt fires here. The user
      // approves on-screen; the Promise resolves with the broadcast tx
      // hash on the relayer side.
      return walletClient.sendTransaction({
        account,
        to: request.to,
        data: request.data,
        value: request.value ?? 0n,
        chain: null,
        maxFeePerGas: request.maxFeePerGas,
        maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      }) as Promise<Hash>
    },
  }
}

/* -------------------------------------------------------------------------- */
/*  Sanity check (no network, no device)                                      */
/* -------------------------------------------------------------------------- */

const FAKE_ADDRESS = ('0x' + 'e'.repeat(40)) as Hex

const fakeLedger: MinimalLedgerEth = {
  getAddress: async () => ({
    publicKey: '0x' + 'f'.repeat(64),
    address: FAKE_ADDRESS,
  }),
  signTransaction: async () => ({
    r: 'a'.repeat(64),
    s: 'b'.repeat(64),
    v: '1c',
  }),
}

const adapter = walletAdapterFromLedger({
  ledger: fakeLedger,
  derivationPath: "44'/60'/0'/0/0",
  address: FAKE_ADDRESS,
  rpcUrl: 'http://127.0.0.1:0',
  chainId: 1,
})

console.log('Sanity check: ledger adapter constructed, address:', adapter.address)

// Confirm cross-chain hard-fail wires through:
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
