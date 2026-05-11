/**
 * 08 — Safe (Gnosis Safe) multisig → `WalletAdapter`.
 *
 * Multisig wallets break the "send a tx, get a hash" assumption.
 * Instead of an immediate on-chain transaction, the user PROPOSES
 * a transaction; the proposal sits in the Safe's pending-tx queue
 * until the configured threshold of owners signs it; once threshold
 * is reached, anyone can execute it (or the Safe's app does so
 * automatically). The "hash" we surface to the dapp is the
 * **safeTxHash** (the proposal identifier), NOT an on-chain tx hash.
 *
 * **This is a semantic departure from EOA send.** Consumers that
 * receive the safeTxHash as if it were an on-chain hash and then
 * try to `getReceipt(hash)` on it will get null forever — the safeTxHash
 * is a structured-data digest, not an Ethereum tx hash. They need to:
 *
 * 1. Treat the returned "hash" as a safeTxHash, distinct from an
 *    on-chain tx hash.
 * 2. Poll the Safe's transaction service (or watch the Safe contract
 *    for the matching `ExecutionSuccess` / `ExecutionFailure` event)
 *    to discover the eventual on-chain hash.
 * 3. Only THEN can tx-tracker / receipt-poll machinery see the txn.
 *
 * Consumer trade-off: simpler dapp code uses the safeTxHash directly
 * and shows "proposed — awaiting owners" until the on-chain hash
 * resolves. UIs that already drive a tx-flight strip via tx-tracker
 * should fork: render "proposed" state from safeTxHash; switch to
 * the tx-tracker stream once the executed hash arrives.
 *
 * Plumbing (omitted so the file typechecks without `@safe-global/protocol-kit`
 * installed):
 *
 *   import Safe from '@safe-global/protocol-kit'
 *   import SafeApiKit from '@safe-global/api-kit'
 *
 *   const protocolKit = await Safe.init({
 *     provider: window.ethereum,
 *     signer: await signerAccount.address,
 *     safeAddress: '0xSafeAddress',
 *   })
 *   const apiKit = new SafeApiKit({ chainId: 1n })
 *
 *   const adapter = walletAdapterFromSafe({
 *     protocolKit,
 *     apiKit,
 *     safeAddress: '0xSafeAddress',
 *     signerAddress: '0xSignerAddress',
 *     chainId: 1,
 *   })
 *
 * Run with: `yarn tsx examples/08-safe-multisig.ts`. The sanity
 * check uses fake protocol-kit + api-kit objects.
 */

import type { Hex } from 'viem'

import type {
  WalletAdapter,
  WalletSendTransactionRequest,
} from '../src/index.js'

/* -------------------------------------------------------------------------- */
/*  Minimal type stubs (mirror @safe-global/protocol-kit + api-kit)           */
/* -------------------------------------------------------------------------- */

interface SafeTransactionData {
  to: string
  data: string
  value: string
  operation?: number // 0 = call, 1 = delegatecall
}

interface MinimalSafeProtocolKit {
  createTransaction(args: {
    transactions: SafeTransactionData[]
  }): Promise<{ data: SafeTransactionData & { nonce: number } }>
  getTransactionHash(safeTransaction: {
    data: SafeTransactionData & { nonce: number }
  }): Promise<string>
  signHash(safeTxHash: string): Promise<{ data: string }>
}

interface MinimalSafeApiKit {
  proposeTransaction(args: {
    safeAddress: string
    safeTransactionData: SafeTransactionData & { nonce: number }
    safeTxHash: string
    senderAddress: string
    senderSignature: string
  }): Promise<void>
}

/* -------------------------------------------------------------------------- */
/*  The bridge                                                                */
/* -------------------------------------------------------------------------- */

interface SafeAdapterOptions {
  protocolKit: MinimalSafeProtocolKit
  apiKit: MinimalSafeApiKit
  safeAddress: Hex
  /** The signer that proposes (and partially signs) the tx. */
  signerAddress: Hex
  chainId: number
}

/**
 * Wrap a Safe multisig as a `WalletAdapter`. Returns the safeTxHash
 * (proposal identifier) — NOT an on-chain tx hash. See the file
 * header for the consumer-visible implications.
 *
 * `adapter.address` is the Safe's address (the on-chain `msg.sender`
 * that any executed transaction will originate from), not the
 * signer's address.
 */
export const walletAdapterFromSafe = (
  options: SafeAdapterOptions,
): WalletAdapter => ({
  address: options.safeAddress,
  sendTransaction: async (
    request: WalletSendTransactionRequest,
  ): Promise<Hex> => {
    if (request.chainId !== options.chainId) {
      throw new Error(
        `Safe adapter is bound to chain ${options.chainId}; got request for chain ${request.chainId}. ` +
          `Construct a separate adapter per chain — Safes are deployed per-chain and the API service ` +
          `is per-chain too.`,
      )
    }
    const safeTransaction = await options.protocolKit.createTransaction({
      transactions: [
        {
          to: request.to,
          data: request.data,
          value: (request.value ?? 0n).toString(),
        },
      ],
    })
    const safeTxHash = await options.protocolKit.getTransactionHash(safeTransaction)
    const signature = await options.protocolKit.signHash(safeTxHash)
    await options.apiKit.proposeTransaction({
      safeAddress: options.safeAddress,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress: options.signerAddress,
      senderSignature: signature.data,
    })
    // IMPORTANT: this is the SAFE TX HASH, not an on-chain tx hash.
    // Consumers should treat it as a proposal identifier and poll
    // the Safe API for the eventual on-chain hash once threshold
    // is reached and execution lands.
    return safeTxHash as Hex
  },
})

/* -------------------------------------------------------------------------- */
/*  Sanity check (no network, no signer)                                      */
/* -------------------------------------------------------------------------- */

const SAFE_ADDRESS = ('0x' + 's'.repeat(40)) as Hex
const SIGNER_ADDRESS = ('0x' + 'a'.repeat(40)) as Hex
const FAKE_SAFE_TX_HASH = ('0x' + 'f'.repeat(64)) as Hex

const fakeProtocolKit: MinimalSafeProtocolKit = {
  createTransaction: async ({ transactions }) => ({
    data: { ...transactions[0], nonce: 0 },
  }),
  getTransactionHash: async () => FAKE_SAFE_TX_HASH,
  signHash: async () => ({ data: '0xsig' }),
}

let proposed = false
const fakeApiKit: MinimalSafeApiKit = {
  proposeTransaction: async () => {
    proposed = true
  },
}

const adapter = walletAdapterFromSafe({
  protocolKit: fakeProtocolKit,
  apiKit: fakeApiKit,
  safeAddress: SAFE_ADDRESS,
  signerAddress: SIGNER_ADDRESS,
  chainId: 1,
})

const safeTxHash = await adapter.sendTransaction({
  to: ('0x' + 'b'.repeat(40)) as Hex,
  data: '0x',
  value: 0n,
  chainId: 1,
})

console.log('Sanity check: Safe adapter returned safeTxHash:', safeTxHash)
console.log('Sanity check: proposal submitted to API kit:', proposed)
console.log('Sanity check: adapter.address is the Safe, not the signer:', adapter.address)

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
