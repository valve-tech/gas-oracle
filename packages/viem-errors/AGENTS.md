# AGENTS.md

Terse reference for AI agents (Claude Code, Cursor, Aider, etc.) integrating
`@valve-tech/viem-errors`. The full README is for humans; this file is for
agents that need to ground their work in the package's actual surface
quickly.

## What this package does

Cause-chain-aware error utilities for viem-based dapps. Pure functions
over viem's nested `cause` chain that solve four problems every dapp
re-implements (and most get slightly wrong):

1. **Detect EIP-1193 user rejections** even when buried under wrapper
   errors whose top-level message looks like a generic failure.
2. **Extract decoded custom Solidity error names** (`HashMismatch`,
   `InsufficientLiquidity`) from viem's nested `data.errorName`
   regardless of how the error is wrapped.
3. **Map raw RPC/wallet/contract errors to short user-facing copy**
   with overridable patterns.
4. **Route wagmi-style `onError` sinks** through one helper so every
   write site has consistent UX.

Pure functions, **no runtime dependencies**. `viem ^2.0.0` is a peer
dependency used only for the `Hex` type — the runtime is plain JS.

## Public API

All exports live under `src/index.ts`. Single subpath; no sub-exports.

```ts
import {
  // chain walk (the foundation everything else is built on)
  walkErrorCause,
  // rejection detection
  isUserRejectionError,
  USER_REJECTION_MESSAGE,
  // custom Solidity error extraction
  extractContractErrorName,
  extractContractErrorNameFromMessage,
  // friendly-message mapping
  getUserFriendlyErrorMessage,
  DEFAULT_ERROR_PATTERNS,
  type ErrorPattern,
  // one-call handler for wagmi onError / catch blocks
  handleWalletError,
  type HandleWalletErrorOptions,
} from '@valve-tech/viem-errors'
```

## The five exports you'll actually call

| Export | Shape | Use when |
|---|---|---|
| `isUserRejectionError(error)` | `boolean` | You need to tell rejection from failure to decide between "reset to idle" vs "show error toast". |
| `extractContractErrorName(error)` | `string \| null` | You want to branch on the decoded Solidity error name (`'IntentExpired'`, `'HashMismatch'`, etc.) without parsing the raw revert message. |
| `getUserFriendlyErrorMessage(error, opts?)` | `string` | You need short user-facing copy and don't want to write the rejection-vs-decoded-vs-pattern pipeline yourself. |
| `handleWalletError(error, opts)` | `void` | One-liner for wagmi's `onError` callback or a catch block. Routes to `setStatus` / `setErrorMessage` / `toast.error|info` / `onError` sinks. |
| `walkErrorCause(error, opts?)` | `Iterable<unknown>` | You're doing custom inspection — generator yields the error then each link in `.cause` (default `maxDepth: 8`). |

## Why three signals for rejection detection

`isUserRejectionError` walks the cause chain checking three signals at every link:

1. EIP-1193 `code === 4001`
2. Class name `UserRejectedRequestError` (viem's typed class)
3. Message regex (`"User rejected"`, `"User denied"`, MetaMask's variants)

Any one is sufficient. The reason: no single signal is reliable across every wallet + version on the wire. WalletConnect drops the EIP-1193 code in some flows; injected providers wrap it in their own error class; mobile wallets sometimes only set the message. Checking all three at every link in the cause chain is the only check that works in production.

## Why walk the cause chain at all

viem nests errors several layers deep:

```
ContractFunctionExecutionError
  └─ cause: RpcRequestError
       └─ cause: UserRejectedRequestError ← the real signal lives here
```

The wrapper's `.message` reads `"Failed to send transaction"`. Top-level message matching misses real rejections; top-level class checks miss them too. `walkErrorCause` is the foundation — every other detector in this package iterates with it.

## The friendly-message pipeline

`getUserFriendlyErrorMessage(error, opts)` runs this order — **rejection check FIRST**:

```
1. isUserRejectionError(error)           → USER_REJECTION_MESSAGE
2. extractContractErrorName(error)       → opts.customErrors[name] (if matched)
3. opts.patterns + DEFAULT_ERROR_PATTERNS → first match's message
4. opts.fallback ?? "Something went wrong. Please try again."
```

Rejection-first matters because a `code === 4001` buried under a wrapper whose top-level message contains `"execution reverted"` must still produce the cancelled-by-user copy — not "transaction reverted on-chain".

`DEFAULT_ERROR_PATTERNS` covers protocol-agnostic cases (insufficient gas, replacement underpriced, rate-limited, network down, generic revert). Protocol-specific decoded errors (`HashMismatch` → "Proof didn't match the deposit") belong in `customErrors`, not in this package.

## `handleWalletError` — the one-line shape

The canonical wagmi shape:

```ts
useContractWrite({
  // ...
  onError: (err) => handleWalletError(err, {
    setStatus,                       // 'idle' on rejection, 'error' on failure
    setErrorMessage: setError,       // null on rejection, friendly text on failure
    toast,                           // toast.info on rejection, toast.error on failure
    customErrors: {
      HashMismatch: 'The proof did not match the deposit.',
      InsufficientLiquidity: 'Not enough liquidity for this trade.',
    },
    onError: (e) => analytics.track('write.error', { message: e.message }),
  }),
})
```

`onError` is always called with the underlying error (coerced to `Error`) so analytics observers get the original. The other sinks branch by classification.

## Pitfalls (read these)

1. **Don't top-level-match for "user rejected".** Use `isUserRejectionError`. Top-level matches miss the buried-in-cause cases that production wallets actually emit.

2. **Don't substring-match for "execution reverted" and bail with a generic message.** Call `extractContractErrorName` first — viem already decoded the error name into `data.errorName` somewhere in the cause chain. Falling back to "transaction failed" throws away the actual signal (`'IntentExpired'`, `'SlippageTooHigh'`).

3. **Don't put protocol-specific copy in `DEFAULT_ERROR_PATTERNS`.** It's intentionally protocol-agnostic. Pass your protocol's custom-error map through `customErrors`.

4. **Don't iterate `.cause` manually with a `while (e.cause) { e = e.cause }` loop.** It's an infinite loop on circular causes (rare, but real — some wallets emit them). `walkErrorCause`'s `maxDepth: 8` cap exists for this.

5. **Don't catch and re-throw without preserving the original.** If you must wrap, set `cause: original` so the chain still walks. `handleWalletError`'s `onError` sink always receives the unwrapped original.

6. **`getUserFriendlyErrorMessage` returns the FIRST pattern match.** If your custom pattern needs to win over a default, prepend it via `patterns: [...myPatterns, ...DEFAULT_ERROR_PATTERNS]` — order matters.

7. **`handleWalletError` does NOT throw or re-throw.** It's a "side-effect-only" handler. If you want the catch block to bail after handling, throw yourself or split the catch:
   ```ts
   try { await writeAsync(...) }
   catch (err) {
     handleWalletError(err, { ... })
     // pipeline-halt logic here
     throw err
   }
   ```

## Composition with sibling packages

`@valve-tech/wallet-adapter`'s `sendTransactionWithHooks` already throws a typed `WalletRejectedError` on rejection (using this package's three-signal detector internally). If you're using wallet-adapter's helpers, you don't need `isUserRejectionError` directly — `instanceof WalletRejectedError` is the canonical discriminator. Use viem-errors directly when you're NOT going through wallet-adapter (raw wagmi `useContractWrite`, raw viem `walletClient.sendTransaction`, etc.).

For decoded-error extraction, viem-errors stays valid even with wallet-adapter — `ContractRevertedError` carries the receipt, but `extractContractErrorName(err)` still gets you the decoded name from the cause chain regardless of which throw path you went through.

## Skills (for AI agents)

`skills/` ships in the npm tarball. If you're an AI agent working in a
project that has installed this package, look in
`node_modules/@valve-tech/viem-errors/skills/viem-errors-integration/SKILL.md`
for trigger conditions, anti-pattern flags, and recipes.

## Verifying provenance

```bash
npm view @valve-tech/viem-errors@latest --json | jq .dist.attestations
npm audit signatures
```
