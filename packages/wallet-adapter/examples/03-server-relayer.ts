/**
 * 03 — Server-side relayer → `WalletAdapter`.
 *
 * Backend dapp pattern. The "wallet" is a private key loaded from an
 * env var or KMS, and the `WalletClient` is built from it directly via
 * viem's `privateKeyToAccount` + `http` transport. No EIP-1193 provider,
 * no user prompt, no chain-switching prompt — the relayer signs
 * autonomously on behalf of users.
 *
 * Used by:
 *
 *   - Sponsored-transaction services (the relayer pays gas; the user's
 *     intent is captured in calldata or an EIP-712 signature).
 *   - Indexer write paths (a backend service that needs to publish
 *     state on-chain in response to off-chain events).
 *   - Gating services that issue typed messages users redeem
 *     on-chain (the relayer doesn't sign txs; the user does).
 *   - Test harnesses + integration tests that need a real on-chain
 *     send without a wallet UI in the loop.
 *
 * Security note: a relayer key controls real funds. **Never check it
 * into source.** Load via process.env, AWS KMS / Google KMS / GCP
 * KMS, HashiCorp Vault, or per-environment secret manager. The
 * example below uses `process.env.RELAYER_PRIVATE_KEY` for clarity;
 * production code should layer on the secret-manager call.
 *
 * Run with: `RELAYER_PRIVATE_KEY=0x... yarn tsx examples/03-server-relayer.ts`.
 * The script ends with a no-network sanity check using a fake transport.
 */

import {
  createWalletClient,
  custom,
  http,
  type Hex,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'

import type {
  WalletAdapter,
  WalletSendTransactionRequest,
} from '../src/index.js'

/* -------------------------------------------------------------------------- */
/*  Relayer construction                                                      */
/* -------------------------------------------------------------------------- */

interface RelayerOptions {
  /** Hex-encoded 32-byte private key (`0x...64 hex chars`). */
  privateKey: Hex
  /** RPC URL the relayer signs against. */
  rpcUrl: string
  /** EVM chain id the relayer is bound to. */
  chainId: number
}

/**
 * Build a `WalletAdapter` for a server-side relayer. The relayer is
 * bound to one chain at construction time — multi-chain backends
 * should construct one adapter per chain rather than trying to make
 * a single relayer reactive to chain switches (the EIP-1193 patterns
 * apply to user wallets, not server keys).
 */
export const walletAdapterFromRelayer = (
  options: RelayerOptions,
): WalletAdapter => {
  const account = privateKeyToAccount(options.privateKey)

  const walletClient: WalletClient = createWalletClient({
    account,
    chain: { ...mainnet, id: options.chainId },
    transport: http(options.rpcUrl),
  }) as unknown as WalletClient

  return {
    address: account.address,
    sendTransaction: async (
      request: WalletSendTransactionRequest,
    ): Promise<Hex> => {
      // Hard-fail on cross-chain requests. A relayer signing for the
      // wrong chain is a real money-loss event (replay-attack vector
      // if the same key is also used on another EVM-compat chain),
      // so this throws rather than auto-switches like the browser
      // pattern does.
      if (request.chainId !== options.chainId) {
        throw new Error(
          `Relayer is bound to chain ${options.chainId}; got request for chain ${request.chainId}. ` +
            `Construct a separate adapter per chain — never switch a relayer's chain mid-session.`,
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
  }
}

/* -------------------------------------------------------------------------- */
/*  Sanity check (no network)                                                 */
/* -------------------------------------------------------------------------- */
/*  Gated on the file being executed directly via tsx — see the runDemo      */
/*  pattern in 01-reown-adapter.ts. Tests can import                         */
/*  `walletAdapterFromRelayer` above without the demo running.               */

const runDemo = async (): Promise<void> => {
  // Throwaway test key — same value viem uses in examples. NEVER use
  // for any real chain.
  const TEST_KEY = ('0x' + 'a'.repeat(64)) as Hex
  const account = privateKeyToAccount(TEST_KEY)

  const fakeWallet: WalletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: custom({
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getTransactionCount') return '0x0'
        if (method === 'eth_estimateGas') return '0x5208'
        if (method === 'eth_gasPrice') return '0x77359400'
        if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00'
        if (method === 'eth_blockNumber') return '0x1'
        if (method === 'eth_getBlockByNumber') {
          return {
            number: '0x1',
            baseFeePerGas: '0x77359400',
            timestamp: '0x0',
            hash: '0x' + '0'.repeat(64),
            parentHash: '0x' + '0'.repeat(64),
            gasLimit: '0x1c9c380',
            gasUsed: '0x0',
          }
        }
        if (method === 'eth_sendRawTransaction') return '0xc0ffee'.padEnd(66, '0')
        if (method === 'eth_sendTransaction') return '0xc0ffee'.padEnd(66, '0')
        throw new Error(`fake relayer: unexpected method ${method}`)
      },
    }),
  })

  const fakeAdapter: WalletAdapter = {
    address: account.address,
    sendTransaction: async (req) => {
      if (req.chainId !== 1) {
        throw new Error(
          `Relayer is bound to chain 1; got request for chain ${req.chainId}.`,
        )
      }
      return fakeWallet.sendTransaction({
        account,
        to: req.to,
        data: req.data,
        value: req.value ?? 0n,
        chain: null,
        maxFeePerGas: req.maxFeePerGas,
        maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      })
    },
  }

  const hash = await fakeAdapter.sendTransaction({
    to: ('0x' + 'b'.repeat(40)) as Hex,
    data: '0x',
    value: 0n,
    chainId: 1,
  })

  let crossChainError: unknown = null
  try {
    await fakeAdapter.sendTransaction({
      to: ('0x' + 'b'.repeat(40)) as Hex,
      data: '0x',
      value: 0n,
      chainId: 137,
    })
  } catch (err) {
    crossChainError = err
  }

  console.log('Sanity check: relayer adapter returned hash', hash)
  console.log('Sanity check: cross-chain rejected with:', (crossChainError as Error).message)
}

if (
  typeof process !== 'undefined' &&
  typeof import.meta.filename === 'string' &&
  import.meta.filename === process.argv[1]
) {
  await runDemo()
}
