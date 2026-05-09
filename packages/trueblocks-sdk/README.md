# `@valve-tech/trueblocks-sdk`

Typed TypeScript HTTP client to a running [TrueBlocks](https://trueblocks.io)
`chifra` daemon. Same verb surface as the upstream Go SDK, delivered
as `fetch`-based REST calls — no Go runtime, no subprocess spawning,
browser/mobile safe.

Part of the
[`valve-tech/evm-toolkit`](https://github.com/valve-tech/evm-toolkit)
monorepo.

## Prerequisite

You need a running `chifra daemon` somewhere this client can reach
over HTTP. That requires installing `trueblocks-core` and indexing
the chains you care about. **This package does not bundle or invoke
chifra.** See [TrueBlocks install docs](https://trueblocks.io/docs/install/install-core/).

If you can't run chifra, this package isn't for you.

## Install

```sh
npm install @valve-tech/trueblocks-sdk
```

No peer dependencies. Uses `globalThis.fetch` (Node 18+, every modern
browser).

## 30-second quickstart

```ts
import { createTrueblocksClient } from '@valve-tech/trueblocks-sdk'

const client = createTrueblocksClient({
  baseUrl: 'http://localhost:8080',
})

// Daemon status
const status = await client.status()
console.log(status)

// Block reads
const blocks = await client.blocks({
  blocks: ['18000000', '18000001'],
})
console.log(blocks)

// List appearances for an address
const appearances = await client.list({
  addrs: ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045'],
})
console.log(appearances)
```

## Public surface

### `createTrueblocksClient(options)`

```ts
interface CreateTrueblocksClientOptions {
  baseUrl: string                     // e.g. 'http://localhost:8080'
  fetch?: typeof globalThis.fetch     // optional override (testing, custom transport)
}
```

Returns a `TrueblocksClient` with one method per chifra endpoint
(flat surface — see [Verbs](#verbs) below).

### Errors

Every chifra-side failure throws a `TrueblocksError`:

```ts
import { TrueblocksError } from '@valve-tech/trueblocks-sdk'

try {
  await client.status()
} catch (err) {
  if (err instanceof TrueblocksError) {
    console.log(err.path)        // chifra endpoint that failed (e.g. '/status')
    console.log(err.status)      // HTTP status if applicable
  }
}
```

### Verbs

Every chifra HTTP endpoint is exposed as a typed method on the
client. Method names match the chifra CLI verbs.

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

**Base methods** return the OpenAPI polymorphic union — useful when
flag combinations are constructed at runtime. **Variants** preselect
a flag (or `mode` enum value, for `chunks`) and narrow the return
type to the single concrete shape that flag produces. Mirrors the
Go SDK's `XxxOptions.XxxFlag()` family.

Example:

```ts
// Polymorphic — narrow at the call site:
const result = await client.blocks({ blocks: ['18000000'], logs: true })
// result.data is (Block | LightBlock | Log | …)[]

// Variant — concrete return type, no narrowing needed:
const result = await client.blocks.logs({ blocks: ['18000000'] })
// result.data is Log[]
```

Per-method query parameters are typed against the upstream OpenAPI
spec — your editor surfaces the available options via IntelliSense.

## License

MIT, in line with the rest of the `@valve-tech/*` toolkit. The
upstream `trueblocks-core` project is GPL-3.0-or-later, but this
package is a clean-room TypeScript reimplementation against the
public OpenAPI spec — no GPL code is incorporated. See the
`LICENSE` file for full terms.
