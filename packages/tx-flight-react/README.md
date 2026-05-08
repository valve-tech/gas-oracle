# `@valve-tech/tx-flight-react`

React UI primitives for an in-flight transaction strip. Provider,
hook, atomic + layout components, pluggable storage. Sits on top of
[`@valve-tech/wallet-adapter`](../wallet-adapter) (the lifecycle
vocabulary) and
[`@valve-tech/tx-tracker`](../tx-tracker) (the per-tx state machine);
both are **optional** peer deps so the package supports either or
both integration shapes without forcing a hard dependency.

Part of the
[`valve-tech/evm-toolkit`](https://github.com/valve-tech/evm-toolkit)
synchronized release line.

## Why

Every dapp ends up rebuilding the same "in-flight strip": a list of
recently-submitted txs that show pending → confirmed | failed |
dropped | replaced, with a hash link to the explorer, an age display,
and (sometimes) speed-up / cancel buttons. The pieces are simple
individually but stitching them together — Provider state, storage,
debounce, eviction, reorg handling, persisting across reload — is
several hundred lines of boilerplate per app.

This package ships those pieces as headless components and a single
hook. Bring your own styles, bring your own wallet, optionally bring
your own tracker. The strip handles the lifecycle wiring.

## Install

```sh
npm install @valve-tech/tx-flight-react viem
# Optional peers — install only the integration shape(s) you need:
npm install @valve-tech/wallet-adapter         # for addWithWalletAdapter
npm install @valve-tech/tx-tracker @valve-tech/chain-source   # for addByHash
```

React 18 or 19, viem ^2.

## 30-second quickstart

```tsx
import {
  TxFlightProvider,
  TxFlightList,
  useTxFlight,
} from '@valve-tech/tx-flight-react'

// 1. Wrap your app
function App() {
  return (
    <TxFlightProvider>
      <Header />
      <TxFlightList />   {/* renders the strip */}
      <YourApp />
    </TxFlightProvider>
  )
}

// 2. Use the hook from anywhere inside the Provider tree
function SubmitButton() {
  const flight = useTxFlight()
  return (
    <button onClick={() => {
      flight.addManual({
        tx: {
          id: crypto.randomUUID(),
          chainId: 1,
          flow: 'send',
          submittedAt: Date.now(),
          submittedTier: 'standard',
          status: 'pending',
        },
      })
    }}>
      Submit
    </button>
  )
}
```

That's a working strip with persistence to localStorage, eviction
after 60s of terminal lifetime, and a 50-item cap.

## Public surface

### Provider

```tsx
<TxFlightProvider
  id="default"                          // string — scopes state + storage key
  storage={localStorageAdapter()}       // TxFlightStorage | null — null disables persistence
  maxItems={50}                         // cap on retained entries
  terminalRetentionMs={60_000}          // how long terminals linger
  onError={(method, err) => ...}        // surfaced for storage / watcher errors
  clientFactory={(chainId) => client}   // optional: enable rehydrate watcher revival
>
  ...
</TxFlightProvider>
```

### Hook

```tsx
const flight = useTxFlight()                   // ambient id
const flight = useTxFlight('settings-page')    // explicit id

flight.txs                                     // ReadonlyArray<TrackedTx>
flight.addWithWalletAdapter(input)             // { id, hooks: WriteHookParams }
flight.addByHash(input)                        // Promise<string>
flight.addManual(input)                        // string
flight.remove(id)                              // void
flight.clear()                                 // void
flight.get(id)                                 // TrackedTx | null
```

Throws if no `<TxFlightProvider>` for the resolved id is in the tree.

### Components

| Component | RSC-safe | Purpose |
|---|---|---|
| `<TxFlightList>` | no (uses hook) | Reactive list. Defaults to newest-first by `submittedAt`, optional `filter` / `sort` / `render` / `empty` props. |
| `<TxFlightItem>` | yes | Default per-tx layout (icon + hash + age + actions). `render` prop swaps the layout while keeping the four atomic children. |
| `<TxFlightStatusIcon>` | yes | Colored dot per status. `size` (default 16). |
| `<TxFlightHashLink>` | yes | `<a>` to explorer (or plain `<span>` fallback when no `explorer` is supplied). Truncation modes: `'middle'` \| `'end'` \| `'none'`. |
| `<TxFlightAge>` | no (uses `useEffect`) | Periodic relative-time display. `format` swaps the wording. |
| `<TxFlightActions>` | yes | Speed-up / cancel / dismiss button slots. Renders nothing when no callbacks are wired. |

Every component accepts `className` and `style`.

### Storage adapters

```ts
import {
  localStorageAdapter,
  indexedDBAdapter,
  memoryAdapter,
} from '@valve-tech/tx-flight-react/storage'
```

| Adapter | When to use |
|---|---|
| `localStorageAdapter({ keyPrefix? })` | Default. Sync API; SSR-safe (no-op when `window` is undefined). |
| `indexedDBAdapter({ dbName?, storeName? })` | Larger payloads, async. |
| `memoryAdapter()` | Tests, or "explicit no persistence". |

A consumer-built adapter just satisfies the two-method `TxFlightStorage`
interface (`load(id) → Promise<TrackedTx[] | null>`,
`save(id, txs) → Promise<void>`).

## Three add shapes

The strip's lifecycle starts when you call one of three add methods.
Each has its own input type and return; there is no overloaded
discriminated `via:` field.

### `addWithWalletAdapter` — when you're using `@valve-tech/wallet-adapter`

```tsx
import { sendTransactionWithHooks } from '@valve-tech/wallet-adapter'

const flight = useTxFlight()

const userHooks = {
  onConfirmed: (info) => myToast(`tx ${info.hash} confirmed`),
}

const { id, hooks } = flight.addWithWalletAdapter({
  hooks: userHooks,
  flow: 'mint',
  chainId: 1,
  request: { to: contract, data, value: 0n, chainId: 1 },
})

// Pipe the wrapped hooks straight into wallet-adapter's helper.
// Each phase fires BOTH your original callback AND a store update.
await sendTransactionWithHooks({ wallet, request, hooks })
```

Sync. Wallet-adapter is statically imported (only types — no runtime
bundle cost).

### `addByHash` — when you have a hash and a viem `PublicClient`

```tsx
const id = await flight.addByHash({
  hash: '0xabc...',
  chainId: 1,
  client: publicClient,
  flow: 'claim',
  withReceipts: true,    // opt into reverted-receipt detection
  confirmations: 3,
})
```

Async — `@valve-tech/tx-tracker` and `@valve-tech/chain-source` are
**dynamic-imported** so wallet-adapter-only consumers don't pay the
bundle cost. The strip builds a private ChainSource + TxTracker
internally; `flight.remove(id)` (or unmount) cleans up the
subscription.

### `addManual` — when you already have a fully-formed `TrackedTx`

```tsx
const id = flight.addManual({
  tx: {
    id: crypto.randomUUID(),
    hash: '0xabc...',
    chainId: 1,
    flow: 'observed-elsewhere',
    submittedAt: Date.now(),
    submittedTier: 'standard',
    status: 'pending',
  },
})
```

Sync. Useful for back-fill (server push, observed-elsewhere txs). The
strip stores the entry verbatim; subsequent updates are the consumer's
responsibility (call `addManual` again with the same `tx.id` to
overwrite, or `flight.remove(id)` to drop).

## Persistence + rehydrate

By default state persists to `localStorage` under the key
`tx-flight:${id}`, debounced ~250ms. On Provider mount, persisted
entries are seeded back into state.

Rehydrate semantics:
- `pending` with `hash` set, **and** `clientFactory` is wired: a fresh
  tx-tracker watcher is async-attached so the entry continues
  advancing toward terminal.
- `pending` without `clientFactory`: stays `pending` until you
  manually re-issue `addByHash`.
- `preparing` / `awaiting-signature`: translated to `failed` with
  `notes: 'lost during reload'` — wallet interactions cannot resume
  across reloads.
- Terminal entries (`confirmed` / `failed` / `dropped` / `replaced`):
  preserved verbatim until the eviction interval prunes them past
  `terminalRetentionMs`.

Set `clientFactory` if you want pending entries to keep advancing
after a reload:

```tsx
<TxFlightProvider
  clientFactory={(chainId) => myPublicClients[chainId]}
>
```

## Multi-instance

Two providers with the same `id` share one underlying store via
refCount; useful for nested layouts where the same logical strip is
mounted in more than one place. Different `id`s are fully independent
(different in-memory state, different storage key).

```tsx
<TxFlightProvider id="main">
  <Layout>
    <TxFlightProvider id="settings-page">
      ...
    </TxFlightProvider>
  </Layout>
</TxFlightProvider>
```

## SSR / RSC

The Provider is a `'use client'` component. Atomic components without
hooks (`StatusIcon`, `HashLink`, `Actions`, `Item`) are RSC-safe.
`<TxFlightAge>` and `<TxFlightList>` use hooks (`useEffect`,
`useTxFlight`) and are client-only.

`localStorageAdapter` no-ops on the server (`typeof window ===
'undefined'`). The Provider's heavyweight side effects (eviction
interval, storage IO, watcher subscriptions) live inside `useEffect`
and never run during `renderToString`.

## License

MIT
