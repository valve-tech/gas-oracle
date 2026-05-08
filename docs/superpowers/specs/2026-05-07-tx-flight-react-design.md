# `@valve-tech/tx-flight-react` v0.9.0 — design

Status: spec, awaiting plan
Targets: `valve-tech/evm-toolkit` v0.9.0 release
Date: 2026-05-07

This spec captures the brainstorming output for **memory item 11** from
`upstream-candidates.md` — a React UI package that consumes the existing
toolkit primitives (`@valve-tech/wallet-adapter`, `@valve-tech/tx-tracker`)
and renders a "tx-flight strip" of in-flight transactions.

The package is the toolkit's first React-only public surface. Every other
package is React-agnostic; the deliberate choice here is to keep
React-specific code in a clearly-named sibling so that consumers in
non-React stacks (CLI, Node, server-side) don't accidentally pull in a
DOM dependency.

---

## 1. Goals

1. **Drop-in tx-flight UI.** A consumer who already wires
   `sendTransactionWithHooks` from `@valve-tech/wallet-adapter` should be
   able to add a flight strip in three lines: wrap their app in
   `<TxFlightProvider>`, place a `<TxFlightList>` somewhere, and call
   `useTxFlight().addWithWalletAdapter({ ... })` from their submit
   handler.
2. **Composable, headless components.** Two layers — atomic primitives
   (`<TxFlightStatusIcon>`, `<TxFlightHashLink>`, `<TxFlightAge>`,
   `<TxFlightActions>`) AND layout helpers (`<TxFlightList>`,
   `<TxFlightItem>`) that compose them. Consumer styles every layer.
3. **Two integration shapes for tracking.** Callers using the
   wallet-adapter primitive get a wallet-adapter `via` shape; callers
   using a raw hash + chain id (no wallet-adapter) get a tx-tracker
   `via` shape. Both feed the same internal reducer so behavior is
   identical post-submission.
4. **Persistence by default.** A reload doesn't lose the in-flight list.
   Pluggable storage with a sensible localStorage default; consumer can
   swap to IndexedDB or memory.
5. **Multi-instance.** A `id` prop scopes a Provider's in-memory state
   AND its storage key, so an app can run multiple flight strips for
   different concerns (main-app vs settings-page) without bleeding.
6. **100/100/100/100 coverage gate.** Same discipline as every other
   package in the toolkit. Forces a design where every code path can be
   exercised by a hermetic test (no live RPC, no real wallet).
7. **SSR / hydration safe.** Default storage adapter no-ops on the
   server, hydrates on mount. Provider is a client component.

## 2. Non-goals (explicit)

- **React Native.** DOM-specific code lands first. RN support could
  arrive in a future `tx-flight-react-native` sibling.
- **Toast / notification system.** We render semantic markup; consumer
  layers `react-hot-toast`, `sonner`, framer-motion, etc. on top.
- **Wallet-bound speed-up / cancel actions.** `<TxFlightActions>`
  exposes button slots and `onSpeedUp` / `onCancel` callbacks, but
  the actual `replaceTransaction` call is the consumer's responsibility
  (different wallets, different gas-recommendation strategies).
- **i18n machinery.** Every visible string flows through an `overrides`
  prop pattern (see §6.5); no `formatMessage` / `useTranslation` baked
  in.
- **State management library.** No Zustand / Redux / Jotai dependency.
  Provider state is held in a `useSyncExternalStore`-backed local
  store. Consumers who already use a state library can ignore this
  package or wrap it.

---

## 3. Public surface

### 3.1 Provider

```tsx
import { TxFlightProvider } from '@valve-tech/tx-flight-react'

<TxFlightProvider id="default" storage={localStorageAdapter()}>
  <App />
</TxFlightProvider>
```

| Prop | Type | Default | Notes |
|---|---|---|---|
| `id` | `string` | `'default'` | Scopes both in-memory state and storage key. Two providers with same `id` silently share state. |
| `storage` | `TxFlightStorage \| null` | `localStorageAdapter()` | `null` disables persistence (memory-only). Pluggable; see §3.5. |
| `maxItems` | `number` | `50` | Cap. Once reached, terminal entries (mined/failed/dropped/replaced older than `terminalRetentionMs`) are evicted before non-terminal. |
| `terminalRetentionMs` | `number` | `60_000` | How long a terminal entry stays in the strip after settling. |
| `onError` | `(method: string, err: unknown) => void` | undefined | Surfaced for storage failures, watcher errors. |

### 3.2 Hook

```tsx
const flight = useTxFlight()
// or: useTxFlight('settings-page')

flight.txs                                      // ReadonlyArray<TrackedTx>
flight.addWithWalletAdapter(input): { id, hooks }
flight.addByHash(input): Promise<string>
flight.addManual(input): string
flight.remove(id)
flight.clear()
flight.get(id)
```

```ts
function useTxFlight(id?: string): {
  /** Reactive snapshot — re-renders on state change. */
  txs: ReadonlyArray<TrackedTx>

  /**
   * Add a tx the consumer is submitting via @valve-tech/wallet-adapter.
   * Returns the assigned id and a wrapped WriteHookParams to pass to
   * sendTransactionWithHooks. The wrap fans every phase to BOTH the
   * caller's original callbacks AND the strip's reducer.
   */
  addWithWalletAdapter(input: AddWithWalletAdapterInput): {
    id: string
    hooks: WriteHookParams
  }

  /**
   * Add a tx by its hash + chainId. Internally builds a private
   * ChainSource + TxTracker and watches the hash. Async because
   * @valve-tech/tx-tracker is dynamic-imported (optional peer dep).
   */
  addByHash(input: AddByHashInput): Promise<string>

  /**
   * Add a fully-formed TrackedTx. Caller drives status updates by
   * calling addManual again with the same id (overwrites in place).
   * Useful for back-fill: server-pushed txs, observed-elsewhere txs.
   */
  addManual(input: AddManualInput): string

  /** Remove an entry by id. No-op if not found. */
  remove(id: string): void

  /** Empty the strip (terminal + non-terminal). */
  clear(): void

  /** Imperative read; doesn't subscribe to re-renders. */
  get(id: string): TrackedTx | null
}
```

If `useTxFlight(id)` is called for an `id` that has no provider in the
tree, the hook throws — same as `useContext` of an unprovided context.
The thrown error is helpful (`No <TxFlightProvider id="${id}"> found in
tree`).

### 3.3 The three add-input shapes

Each method takes its own input type. The shapes are independent — no
discriminated `via:` field, no overlap.

#### `addWithWalletAdapter(input)`

```ts
interface AddWithWalletAdapterInput {
  /** The hooks bag the consumer is already passing to sendTransactionWithHooks. */
  hooks: WriteHookParams
  /** Required — TrackedTx.flow. */
  flow: TxFlowKey
  /** Required — TrackedTx.chainId. */
  chainId: number
  /** Required — TrackedTx.request, used for replay/replace. */
  request: WalletSendTransactionRequest
}
```

Wraps `input.hooks` so each phase fans to both the consumer's original
callbacks AND the strip's store dispatch. The returned `hooks` is what
the consumer passes to `sendTransactionWithHooks`. The original
`input.hooks` is left untouched (no mutation).

Sync. wallet-adapter is statically imported (its types are already
re-exported from `index.ts`).

#### `addByHash(input)`

```ts
interface AddByHashInput {
  hash: Hex
  chainId: number
  /** viem PublicClient pointed at the chain. The package builds a private
   *  ChainSource + TxTracker internally. */
  client: PublicClient
  flow?: TxFlowKey
  /** Optional confirmations / staleAfterBlocks; threaded into the internal tracker. */
  confirmations?: number
  staleAfterBlocks?: number
  /** If true, fetches the receipt at inclusion and surfaces revert as `failed`. */
  withReceipts?: boolean
}
```

Async. Dynamic-imports `@valve-tech/tx-tracker` and
`@valve-tech/chain-source` so callers who only ever use the
wallet-adapter path don't pay the bundle cost. Returns once the
internal subscription is active.

#### `addManual(input)`

```ts
interface AddManualInput {
  tx: TrackedTx
}
```

Sync. The strip stores the entry verbatim. The caller drives subsequent
status updates by calling `addManual` again with the same `tx.id`
(overwrites in place) or by calling `remove(id)` to drop it. The strip
does NOT auto-update manual entries — no internal watcher is created.

### 3.4 Components

#### Layout

```tsx
<TxFlightList
  id?            // defaults to ambient provider's id
  filter?        // (tx) => boolean — e.g., hide terminals
  sort?          // (a, b) => number — defaults to newest-first by submittedAt
  render?        // (tx) => ReactNode — defaults to <TxFlightItem tx={tx} />
  empty?         // ReactNode shown when txs is empty
/>

<TxFlightItem
  tx
  render?        // (parts: { icon, hash, age, actions }) => ReactNode
/>
```

#### Atomic

```tsx
<TxFlightStatusIcon
  status         // TX_STATUS value
  size?          // px, default 16
/>

<TxFlightHashLink
  tx
  explorer?      // (tx) => string  — URL builder; default uses chain-source/explorer.ts? (see §4.2)
  truncate?      // 'middle' | 'end' | 'none', default 'middle' (0x1234…abcd)
/>

<TxFlightAge
  submittedAt    // ms since epoch
  refreshIntervalMs?   // default 1000
  format?        // (deltaMs) => string, default 'just now' / '12s ago' / '3m ago' / etc.
/>

<TxFlightActions
  tx
  onSpeedUp?     // (tx) => void
  onCancel?      // (tx) => void
  onDismiss?     // (tx) => void  — removes from strip
  show?: { speedUp?: boolean; cancel?: boolean; dismiss?: boolean }
/>
```

Every component accepts `className` and `style` for the consumer to
override styling. No CSS-in-JS dependency.

### 3.5 Storage adapter

```ts
export interface TxFlightStorage {
  /** Returns null if no entry exists. Throws on adapter-level errors. */
  load(id: string): Promise<TrackedTx[] | null>

  /** Replace stored value. Called debounced ~250ms. */
  save(id: string, txs: TrackedTx[]): Promise<void>
}

// Built-ins:
import {
  localStorageAdapter,
  indexedDBAdapter,
  memoryAdapter,
} from '@valve-tech/tx-flight-react/storage'
```

| Adapter | Default? | Notes |
|---|---|---|
| `localStorageAdapter(opts?)` | yes | `opts.keyPrefix` defaults to `'tx-flight'`. Storage key is `${keyPrefix}:${id}`. Sync API; debounced save. SSR-safe (no-op when `window === undefined`). |
| `indexedDBAdapter(opts?)` | no | `opts.dbName` default `'tx-flight'`, `opts.storeName` default `'flights'`. Async; survives larger payloads. |
| `memoryAdapter()` | no | Test seam. |

A consumer-built adapter just satisfies the two-method interface.

### 3.6 The `TrackedTx` shape

Re-exported from `@valve-tech/wallet-adapter`'s existing definition. The
strip stores entries verbatim — no shape divergence. Status values from
`TX_STATUS`:

```
preparing            (only via 'wallet-adapter' before signature)
awaitingSignature    (only via 'wallet-adapter')
pending              (post-submission, observed in mempool or block)
mined                (terminal, success — receipt.status === '0x1')
failed               (terminal, on-chain revert OR wallet error)
dropped              (terminal, unseen-for-N-blocks)
replaced             (terminal, replaced-by event observed)
```

`TrackedTx.notes?: string` carries human-readable detail (e.g., the
revert reason from the receipt, the reject reason from the wallet).

### 3.7 Replacement semantics

When a `replaced-by` event fires for a tracked tx (via either path), the
existing entry's status flips to `replaced` and `replacementHash` is
set. **A new entry is NOT auto-added** — same as `tracker.group`'s
spec §18.1 contract. Consumers who want the replacement watched can
`add()` it explicitly with the new hash.

This keeps the strip honest: the user sees their original submission
end as `replaced`, and if they (or their app) actively continued the
flow, the new entry shows up on its own merits.

---

## 4. Internal architecture

### 4.1 Store

A small `useSyncExternalStore`-backed store, one per `id`. The store
holds:

```ts
interface InternalState {
  txs: Map<string, TrackedTx>
  // Per-tx unsubscribe handles for active watchers.
  watchers: Map<string, () => void>
}
```

Reducers (pure functions, exported for testing):

- `addReducer(state, input): { state, txId, watcher? }` — returns
  the next state, the assigned id, and an optional watcher-creation
  thunk that the Provider runs on commit.
- `updateReducer(state, txId, patch): state` — fold in a status patch.
- `removeReducer(state, txId): state` — also calls the watcher's
  unsub if present.
- `evictReducer(state, maxItems, terminalRetentionMs, now): state`
  — applied periodically by the Provider on a `setInterval` tick.

The reducers are pure; the Provider performs side effects (start
watchers, cancel watchers, persist).

### 4.2 Explorer URL helper

`<TxFlightHashLink>` needs to render an explorer URL. We don't ship a
chain-id → explorer map (that's a maintenance liability). Instead the
component accepts an `explorer?: (tx) => string` prop. The Provider
also accepts `defaultExplorer?: (tx) => string` so consumers can set
it once for the whole tree.

When neither is set, the link renders the truncated hash as plain text
(no anchor) — silent graceful degradation.

### 4.3 Wallet-adapter integration

`addWithWalletAdapter` does not call `sendTransactionWithHooks` itself —
the consumer does. We just *augment* their hooks bag:

```ts
const wrappedHooks: WriteHookParams = {
  ...userHooks,
  onAwaitingSignature: (event) => {
    userHooks.onAwaitingSignature?.(event)
    store.update(txId, { status: TX_STATUS.awaitingSignature, ... })
  },
  onTransactionHash: (event) => {
    userHooks.onTransactionHash?.(event)
    store.update(txId, { status: TX_STATUS.pending, hash: event.hash })
  },
  onConfirmed: (event) => {
    userHooks.onConfirmed?.(event)
    store.update(txId, { status: TX_STATUS.mined, ... })
  },
  // ... onFailed, onDropped, onReplaced, onPhase
}
```

The augmented hooks are returned synchronously, so the consumer wires
them straight into `sendTransactionWithHooks`:

```ts
const { id, hooks } = flight.addWithWalletAdapter({ hooks: userHooks, flow, chainId, request })
sendTransactionWithHooks({ wallet, request, hooks })
```

The original `userHooks` object is left untouched (no mutation). The
consumer can keep a reference to it for any other purpose; the wrapped
copy is independent.

### 4.4 tx-tracker integration

`addByHash` builds a private `ChainSource + TxTracker` pair (same
pattern as `watchTransaction` in tx-tracker), subscribes to the hash
with the consumer-provided `withReceipts` flag, and routes every
event into the store reducer. The unsub function lives in
`state.watchers` so `remove(id)` and Provider unmount tear it down
cleanly.

`@valve-tech/tx-tracker` and `@valve-tech/chain-source` are
**dynamic-imported** inside `addByHash` so wallet-adapter-only
consumers don't pay the bundle cost. This is what makes `addByHash`
async. The promise resolves once the subscription is registered (one
microtask after the imports settle).

Internally we use `tracker.subscribe(hash, cb, { withReceipts })`
directly rather than the higher-level `watchTransaction` — same
behavior, but lets us hook the `seen-in-mempool` mid-stream event for
the strip's `pending` status update without adding a separate
subscription.

### 4.5 Persistence + rehydrate

On Provider mount:
1. Storage adapter `load(id)` runs. If non-null, store seeds from it.
2. For every entry where `status === pending` or `awaitingSignature`,
   the Provider re-issues a watcher:
   - `pending` with a `hash`: re-subscribe via tx-tracker. Continues
     where it left off.
   - `awaitingSignature` (no hash yet): drop to `failed` with
     `notes: 'lost during reload'`. We can't resume a wallet
     interaction across reloads.

On state change: `save(id, [...txs.values()])` is debounced ~250ms.

On Provider unmount: cancel debounce, flush a final save synchronously.

### 4.6 Eviction

A `setInterval` (~5s) calls `evictReducer`:
- Drop terminal entries older than `terminalRetentionMs`.
- If still over `maxItems`, drop oldest non-terminal (this should
  almost never happen — typical flight lists are <10 items).

---

## 5. Coverage architecture

This section is load-bearing. The toolkit's 100/100/100/100 gate must
hold for the new package, which means every code path needs an
exerciseable test seam.

### 5.1 Reducers

Pure functions, easy. Direct unit tests with synthetic state +
synthetic patches. Covers `addReducer`, `updateReducer`,
`removeReducer`, `evictReducer`.

### 5.2 Storage adapters

`localStorageAdapter` and `indexedDBAdapter` need stub implementations
of the underlying browser APIs. Vitest's `happy-dom` or `jsdom`
environment provides `localStorage`. `IndexedDB` requires
`fake-indexeddb` (devDep, not in published bundle).

`memoryAdapter` is trivial. Covers the SSR no-op path with a
`globalThis.window === undefined` test fixture.

### 5.3 Provider + hook

JSDOM environment + `@testing-library/react`. Tests:
- Provider mounts, hook returns initial state.
- `add` dispatches state change, hook re-renders.
- Two providers with different `id` are independent.
- Two providers with same `id` share state (last-write-wins on conflict).
- Unmount cleans up watchers.
- Rehydrate replays storage on mount.
- `useTxFlight` outside provider throws.

### 5.4 Components

`@testing-library/react` smoke tests. Each atomic component renders
expected DOM given props. Layout components render a list and forward
render-props.

### 5.5 Wallet-adapter integration

Stub `WriteHookParams` with `vi.fn()` callbacks. Drive each phase by
calling the wrapped hooks; assert that (a) the user's original
callback fires, AND (b) the store updates correctly.

### 5.6 tx-tracker integration

Same `_sourceOverride` test seam pattern as `watchTransaction.test.ts`.
Inject a stub ChainSource that the test can drive synchronously. Cover
`pending` → `mined`, `pending` → `dropped`, `pending` → `replaced`,
`pending` → `failed` (withReceipts).

### 5.7 SSR / hydration

`vitest --environment node` for one suite that imports the package
without a `window`. Storage adapter no-ops; Provider doesn't crash on
mount in a synthesized hydrate.

Most tests run under `jsdom` / `happy-dom`. The SSR suite is gated by
its own `describe.concurrent` block with `{ environment: 'node' }`
hint (vitest 4 supports per-test environment overrides via
`// @vitest-environment node`).

---

## 6. Bundle + peer-dep posture

### 6.1 Peer dependencies

```json
{
  "peerDependencies": {
    "react": "^18.2.0 || ^19.0.0",
    "react-dom": "^18.2.0 || ^19.0.0",
    "viem": "^2.21.0"
  },
  "peerDependenciesMeta": {
    "@valve-tech/wallet-adapter": { "optional": true },
    "@valve-tech/tx-tracker": { "optional": true }
  }
}
```

`@valve-tech/wallet-adapter` and `@valve-tech/tx-tracker` are
**optional** peers. The package only requires them when the
corresponding `via` shape is used. Two ESM sub-entries:

```
@valve-tech/tx-flight-react              # core: Provider, hook, components, manual via
@valve-tech/tx-flight-react/storage      # storage adapters
```

The tx-tracker integration (used by `addByHash`) is dynamic-imported
lazily inside the relevant `add(...)` arm. Trees that only use one
shape don't pay the bundle cost of the other.

### 6.2 Bundle target

Same as the rest of the toolkit:
- ESM-only (`"type": "module"`)
- Targets Node 22 + modern browsers (ES2022)
- Source ships as TypeScript; build emits `.js` + `.d.ts` to `dist/`
- React JSX runtime: `react-jsx` (not classic)

### 6.3 SSR + RSC

The Provider is a client component (`'use client'`). Atomic components
that use no hooks (pure renderers) are RSC-compatible. We mark them
with `'use client'` only where `useEffect` / `useState` is used.

`<TxFlightAge>` uses `useEffect` for the periodic refresh; client-only.
The other atomic components are pure and RSC-safe.

### 6.4 Tree-shaking

Each component / hook is a named export. No `import * as` star-exports
internally. `sideEffects: false` in package.json.

### 6.5 i18n hook

Every visible string flows through one of:

- A static default in the component (e.g., `<TxFlightAge>` formatter
  default is English).
- A prop on the consuming component (e.g.,
  `<TxFlightStatusIcon labels={...}>`).
- A Provider-level `defaults` prop that components read via context if
  no per-component override is set.

Consumers swap per-component or per-tree without us depending on
`react-intl` / `react-i18next`.

---

## 7. Versioning + release

This package is **new**; first publish goes through the manual-first-
publish dance from `releasing-evm-toolkit`'s "Adding a NEW package"
section.

After that, synced versioning resumes. The toolkit's other five
packages bump to v0.9.0 in the same release as `tx-flight-react@0.9.0`
ships. Their CHANGELOG entries are short ("Synchronized release —
no changes to this package").

---

## 8. Open questions / deferred

These don't block the v0.9.0 ship; they're flagged for follow-up.

- **Speed-up + cancel UX.** `<TxFlightActions>` exposes button slots
  and callbacks; the actual `replaceTransaction` wiring is a
  consumer concern in v0.9. A future v0.9.x might offer a
  `useReplaceTransaction(tx)` hook that wraps wallet-adapter +
  gas-oracle. Out of scope today.
- **Animation.** No motion primitives. Consumer wraps with framer-motion,
  CSS transitions, or `<TransitionGroup>` themselves. The list emits
  stable `key`s so animations work.
- **Dark / light theme.** No theming primitives. CSS variables on the
  consumer's root are sufficient.
- **Multi-chain UX detail.** TrackedTx already carries `chainId`. The
  default item layout shows it; the consumer can override.

---

## 9. Plan link

Implementation plan to follow in
`docs/superpowers/plans/2026-05-07-tx-flight-react.md`.
