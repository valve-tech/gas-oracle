# AGENTS.md

Terse reference for AI agents (Claude Code, Cursor, Aider, etc.) integrating
`@valve-tech/trueblocks-sdk`. The full README is for humans; this file is for
agents that need to ground their work in the package's actual surface
quickly.

(For contributor-facing notes — codegen pipeline, file map,
clean-room rule, test pattern — see `INTERNALS.md` in the package
root, not shipped in the npm tarball.)

## What this package does

Typed TypeScript HTTP client to a running [TrueBlocks](https://trueblocks.io)
`chifra daemon`. Same verb surface as the upstream Go SDK, delivered
as `fetch`-based REST calls — no Go runtime, no subprocess spawning,
browser/mobile safe.

54 methods total: 18 base methods (one per chifra HTTP endpoint) +
36 narrowed variant accessors on the polymorphic ones (e.g.
`client.blocks.logs(...)` returns `Log[]` instead of the polymorphic
`(Block | LightBlock | Log | …)[]` union).

**No peer dependencies.** Uses `globalThis.fetch` (Node 18+, every
modern browser).

**Prerequisite:** a running `chifra daemon` somewhere this client
can reach over HTTP. This package does NOT bundle or invoke chifra —
the user installs `trueblocks-core` separately and indexes the chains
they care about. If they can't run chifra, this package isn't for
them.

## Public API

All exports live under `src/index.ts`. Single subpath; no sub-exports.

```ts
import {
  createTrueblocksClient,             // primary constructor
  TrueblocksError,                    // typed error class
  // verb-machinery exports (rare to import directly)
  createVerbs,
  makeVerb,
  // types
  type CreateTrueblocksClientOptions,
  type TrueblocksClient,
  type FetchFn,
  type RequestFn,
  type Query,
  type Response,
  type VerbFn,
  type Verbs,
  type IsRequiredQuery,
  // raw OpenAPI types (escape hatch when the verb wrapper isn't enough)
  type components,
  type operations,
  type paths,
} from '@valve-tech/trueblocks-sdk'
```

## Three things you must know

| | |
|---|---|
| **Constructor** | `createTrueblocksClient({ baseUrl: 'http://localhost:8080' })` returns a `TrueblocksClient` with one method per chifra endpoint. Optional `fetch` override for testing or custom transport. |
| **Verb shape** | Every chifra HTTP endpoint is a typed method on the client. Method names match the chifra CLI verbs (`list`, `export`, `blocks`, `transactions`, etc.). |
| **Polymorphic vs variant** | Base methods return the OpenAPI polymorphic union (useful when flag combinations are constructed at runtime). Variants (`client.blocks.logs(...)`) preselect a flag and narrow the return type to the single concrete shape that flag produces. Mirrors the Go SDK's `XxxOptions.XxxFlag()` pattern. |

## The verb surface (54 methods)

| Group | Method | Endpoint | Variants |
|---|---|---|---|
| Accounts | `client.list(...)` | `GET /list` | — |
| Accounts | `client.export(...)` | `GET /export` | `.appearances` `.receipts` `.logs` `.approvals` `.traces` `.neighbors` `.statements` `.transfers` `.assets` `.balances` `.withdrawals` `.count` |
| Accounts | `client.monitors(...)` | `GET /monitors` | — |
| Accounts | `client.names(...)` | `GET /names` | — |
| Accounts | `client.abis(...)` | `GET /abis` | — |
| Chain Data | `client.blocks(...)` | `GET /blocks` | `.hashes` `.uncles` `.traces` `.uniq` `.logs` `.withdrawals` `.count` |
| Chain Data | `client.transactions(...)` | `GET /transactions` | `.traces` `.uniq` `.logs` |
| Chain Data | `client.receipts(...)` | `GET /receipts` | — |
| Chain Data | `client.logs(...)` | `GET /logs` | — |
| Chain Data | `client.traces(...)` | `GET /traces` | `.count` |
| Chain State | `client.when(...)` | `GET /when` | — |
| Chain State | `client.state(...)` | `GET /state` | `.call` |
| Chain State | `client.tokens(...)` | `GET /tokens` | — |
| Admin | `client.config(...)` | `GET /config` | — |
| Admin | `client.status(...)` | `GET /status` | — |
| Admin | `client.chunks(...)` | `GET /chunks` | `.manifest` `.index` `.blooms` `.pins` `.addresses` `.appearances` `.stats` |
| Admin | `client.init(...)` | `GET /init` | — |
| Other | `client.slurp(...)` | `GET /slurp` | `.appearances` `.count` |

`client.send(...)` (`chifra send`) is NOT exposed — the upstream
OpenAPI spec doesn't currently cover it, and this package is
codegen-driven so unspec'd endpoints are not in the surface. To send
transactions, use a wallet library (viem/ethers/wagmi) or
`@valve-tech/wallet-adapter` directly.

## Polymorphic vs variant — when to use which

```ts
// Polymorphic — narrow at the call site:
const result = await client.blocks({ blocks: ['18000000'], logs: true })
// result.data is (Block | LightBlock | Log | …)[]
if (result.data[0]?.address) {
  // narrowed to Log
}

// Variant — concrete return type, no narrowing needed:
const result = await client.blocks.logs({ blocks: ['18000000'] })
// result.data is Log[]
result.data[0]?.address  // ✓ already narrowed
```

Use the variant when the flag is known statically. Use the polymorphic
shape when flag combinations are computed at runtime (e.g. building a
chifra query from a UI toggle).

## Errors

Every chifra-side failure throws a `TrueblocksError`:

```ts
try {
  await client.status()
} catch (err) {
  if (err instanceof TrueblocksError) {
    err.path        // chifra endpoint that failed (e.g. '/status')
    err.status      // HTTP status if applicable
  }
}
```

No silent fallbacks: if the daemon returns an error or an unexpected
shape, you get a typed throw.

## Pitfalls (read these)

1. **Forgetting the daemon prerequisite.** This package is a *client* —
   it talks to a running `chifra daemon`. If `baseUrl` doesn't have a
   chifra serving on the other end, every call throws a
   `TrueblocksError` with a connection failure. The package can't help
   the user install or run chifra; redirect them to
   https://trueblocks.io/docs/install/install-core/.

2. **Calling `client.send(...)`.** It doesn't exist — chifra's send
   surface isn't in the upstream OpenAPI spec, so it's not in the
   typed client. To send a transaction, use viem/ethers/wagmi or
   `@valve-tech/wallet-adapter`. Use trueblocks-sdk for the *read*
   side (history, receipts, traces, balances).

3. **Mixing `client.blocks(...)` polymorphic with branch-by-shape
   logic.** When the result is the polymorphic union, narrow with a
   type guard or an `if (data[0]?.specificField)` check. Use the
   variant accessor (`client.blocks.logs(...)`) instead if the
   polymorphism isn't load-bearing — it removes the narrowing
   ceremony.

4. **Treating `client.list(...)` results as full transactions.**
   `list` returns *appearances* (lightweight pointers — `bn`/`tx_id`/
   `address` triples), not full transactions or receipts. To go from
   appearance to data, follow up with `client.transactions(...)` /
   `client.receipts(...)`.

5. **Calling `client.export(...)` without `addrs`.** Most `export`
   variants are address-scoped — the request shape will be a TS
   error if `addrs` is required, but worth flagging because the
   error message points at the codegen'd schema, not the
   human-readable docs.

6. **Building URLs by hand to add a flag the SDK doesn't expose.**
   The codegen'd types reflect the spec — every flag the spec
   declares is on the verb method's `Query` type. If something
   appears missing, check the chifra version pinned in
   `scripts/codegen.mjs` (in the source repo) — the spec may be
   newer than the pin.

7. **bigint vs string at numeric boundaries.** Generated types
   carry whatever the spec said (often `string` for safety —
   block numbers, gas, fees can exceed 2^53). The verb wrappers
   convert at the boundary where appropriate, but always-string
   fields stay strings. Test before assuming a `bigint` arrived.

8. **No retry / backoff built in.** The client makes one fetch call
   per verb invocation. If the user wants retries, they wrap the
   call themselves or pass a custom `fetch` that retries.

## Composition

trueblocks-sdk is read-side history/state. It composes with:

- **`@valve-tech/wallet-adapter`** — for the write/send side, since
  the SDK doesn't expose `send`.
- **`@valve-tech/tx-tracker`** — for live per-tx state-machine work.
  trueblocks gives you historical reads; tx-tracker watches
  in-flight txs as they confirm. Different layers, complementary.
- **`@valve-tech/chain-source`** — for raw block/mempool streams.
  trueblocks is server-side indexed history; chain-source is local
  RPC observation.

## When to skip this package

- **No running chifra daemon.** Use viem/ethers directly against an
  RPC. Chifra's value is precomputed indexes (appearances,
  monitors); without the daemon, this package is just an HTTP
  client to an endpoint that won't respond.
- **Live in-flight tx tracking.** Use `@valve-tech/tx-tracker`.
  trueblocks is for historical reads, not push-style observation
  of new chain events.
- **Sending transactions.** Use a wallet library (or
  `@valve-tech/wallet-adapter`). chifra's send surface isn't
  exposed here.

## Skills (for AI agents)

`skills/` ships in the npm tarball. If you're an AI agent working in a
project that has installed this package, look in
`node_modules/@valve-tech/trueblocks-sdk/skills/trueblocks-sdk-integration/SKILL.md`
for trigger conditions, anti-pattern flags, and integration recipes.

## Verifying provenance

```bash
npm view @valve-tech/trueblocks-sdk@latest --json | jq .dist.attestations
npm audit signatures
```
