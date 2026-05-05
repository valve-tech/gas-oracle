/**
 * @fileoverview The framework-agnostic wallet contract.
 *
 * Decouples SDKs from any specific wallet library. A `WalletAdapter` is
 * the only seam an SDK needs to sign and send a transaction; the dapp
 * decides whether that backend is wagmi, ethers, viem direct, a smart
 * account, a multisig, or a relayer.
 */

import type { Hex } from 'viem'

/**
 * The minimal request shape an SDK passes to a wallet for sign + send.
 *
 * Fields:
 * - `to`        — destination address.
 * - `data`      — encoded calldata (`0x...`).
 * - `value`     — native-token amount in wei. Defaults to 0 if omitted.
 * - `chainId`   — chain to sign for. Wallets MUST validate this against
 *                 the connected chain and throw rather than silently
 *                 sign for the wrong network.
 * - `maxFeePerGas` / `maxPriorityFeePerGas` — EIP-1559 gas pricing in
 *                 wei. Optional so a wallet can defer to its own gas
 *                 logic; if both are present, the wallet should honour
 *                 them.
 */
export interface WalletSendTransactionRequest {
  to: Hex
  data: Hex
  value?: bigint
  chainId: number
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
}

/**
 * Optional read-from-contract escape hatch. Wallets that proxy reads
 * (e.g. account abstraction with custom RPC) implement this; the SDK
 * falls back to a public RPC when omitted.
 */
export interface WalletReadContractRequest {
  address: Hex
  abi: readonly unknown[]
  functionName: string
  args?: readonly unknown[]
  chainId?: number
}

/**
 * Framework-agnostic wallet interface. Works with wagmi, viem direct,
 * ethers, smart accounts, and relayers — anything that can sign and
 * send a transaction.
 *
 * SDKs should accept a `WalletAdapter` rather than tying themselves to
 * a specific wallet library, so the same SDK works across the whole
 * downstream landscape without per-wallet code paths.
 */
export interface WalletAdapter {
  /** Connected address, or undefined if disconnected. */
  address?: Hex
  /** Sign and send a transaction. Returns the on-chain tx hash. */
  sendTransaction(request: WalletSendTransactionRequest): Promise<Hex>
  /**
   * Optional contract read. SDKs SHOULD prefer this when present (lets a
   * smart-account / paymaster-aware wallet route reads through its own
   * pipeline) and fall back to a public RPC client otherwise.
   */
  readContract?(request: WalletReadContractRequest): Promise<unknown>
}
