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

| Group | Method | Endpoint | Description |
|---|---|---|---|
| Accounts | `client.list(...)` | `GET /list` | Address appearances |
| Accounts | `client.export(...)` | `GET /export` | Full transaction export |
| Accounts | `client.monitors(...)` | `GET /monitors` | Monitor management |
| Accounts | `client.names(...)` | `GET /names` | Address-to-name mappings |
| Accounts | `client.abis(...)` | `GET /abis` | Contract ABIs |
| Chain Data | `client.blocks(...)` | `GET /blocks` | Block reads (polymorphic) |
| Chain Data | `client.transactions(...)` | `GET /transactions` | Transaction reads |
| Chain Data | `client.receipts(...)` | `GET /receipts` | Receipt reads |
| Chain Data | `client.logs(...)` | `GET /logs` | Event log reads |
| Chain Data | `client.traces(...)` | `GET /traces` | Execution traces |
| Chain State | `client.when(...)` | `GET /when` | Block-by-time queries |
| Chain State | `client.state(...)` | `GET /state` | Account state at block |
| Chain State | `client.tokens(...)` | `GET /tokens` | Token balances |
| Admin | `client.config(...)` | `GET /config` | Daemon configuration |
| Admin | `client.status(...)` | `GET /status` | Daemon health |
| Admin | `client.chunks(...)` | `GET /chunks` | Index chunk management |
| Admin | `client.init(...)` | `GET /init` | Index initialization |
| Other | `client.slurp(...)` | `GET /slurp` | 3rd-party tx fetch |

Per-method query parameters and response shapes are typed against
the upstream OpenAPI spec — your editor surfaces the available
options via IntelliSense.

## License

MIT (this package). Note that the upstream `chifra` daemon and its
OpenAPI spec are GPL-3.0-or-later; this client consumes chifra's
public network API and is not a derivative work of the Go SDK
(reimplements the API surface from the spec only).
