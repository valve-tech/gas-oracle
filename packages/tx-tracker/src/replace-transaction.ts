/**
 * `replaceTransaction` — same-nonce replacement primitive. Provex
 * upstream item 5 (memory: upstream-candidates.md#L50). Caller
 * provides `original` (the previously-submitted request, including
 * calldata + nonce) and `newGas` (the bumped EIP-1559 fee params,
 * computed via @valve-tech/gas-oracle's helper or the caller's own
 * math).
 *
 * **tx-tracker MUST NOT import from @valve-tech/gas-oracle.** Sibling
 * packages, kept independent. The bump-rule helper ships separately
 * in gas-oracle. See project memory:
 * transaction-verbs-package-placement.md.
 */

import type { Address, Hex, WalletClient } from 'viem'

export interface ReplaceTransactionOriginal {
  to: Address
  nonce: number
  data?: Hex
  value?: bigint
  chainId?: number
}

export interface ReplaceTransactionNewGas {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

export interface ReplaceTransactionOptions {
  original: ReplaceTransactionOriginal
  walletClient: WalletClient
  newGas: ReplaceTransactionNewGas
}

/**
 * Submit a same-nonce replacement transaction with bumped gas.
 * Returns the new tx hash. Throws whatever the wallet client throws
 * (no swallowing — caller decides retry / surface).
 *
 * @example
 *   import { replaceTransaction } from '@valve-tech/tx-tracker'
 *
 *   const newHash = await replaceTransaction({
 *     original: { to: '0xrecipient', nonce: 42, data: '0x...', value: 0n },
 *     walletClient,
 *     newGas: bumpForReplacement(currentGas), // from @valve-tech/gas-oracle
 *   })
 */
export const replaceTransaction = async (
  options: ReplaceTransactionOptions,
): Promise<Hex> => {
  const { original, walletClient, newGas } = options
  if (!walletClient.account) {
    throw new Error('replaceTransaction: walletClient must have an account')
  }
  // viem's WalletClient.sendTransaction has multiple overloads with strict
  // type-narrowing on chain/account. Cast is necessary to thread the request
  // through the type system without consumers having to specify all generic params.
  return walletClient.sendTransaction({
    account: walletClient.account,
    chain: null,
    to: original.to,
    data: original.data,
    value: original.value,
    nonce: original.nonce,
    maxFeePerGas: newGas.maxFeePerGas,
    maxPriorityFeePerGas: newGas.maxPriorityFeePerGas,
  } as Parameters<typeof walletClient.sendTransaction>[0])
}
