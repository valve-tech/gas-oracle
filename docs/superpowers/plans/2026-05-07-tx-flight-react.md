# `@valve-tech/tx-flight-react` v0.9.0 — implementation plan

Status: plan, awaiting execution
Targets: `valve-tech/evm-toolkit` v0.9.0 release
Spec: `docs/superpowers/specs/2026-05-07-tx-flight-react-design.md`

This plan executes the spec in 12 verifiable commits on a single
feature branch (`feat/v0.9.0-tx-flight-react`), followed by a synced
release tag (`v0.9.0`) covering all six packages.

## Verification gate (applied after every task)

```bash
# From repo root, with PATH including Node 22:
corepack yarn typecheck                                                      # whole-workspace
corepack yarn lint                                                           # whole-workspace
node node_modules/vitest/vitest.mjs run --root packages/tx-flight-react      # new package
node node_modules/vitest/vitest.mjs run --root packages/tx-flight-react --coverage
node node_modules/vitest/vitest.mjs run                                      # all packages, no coverage
```

**Coverage gate:** the new package must hold **100/100/100/100**
stmts/branches/funcs/lines from the first test-bearing commit onward.
Every other package stays at 100/100/100/100.

If a task adds code that introduces an unreachable defensive guard,
delete the guard or restructure the data flow. **Do not add `c8 ignore`
annotations.** This was the discipline applied to v0.8.0 (commits
`8c86bf1` → `1b6019c`) and reinforced in v0.8.1 (commit `913a733`).

## Branch + release shape

- One branch: `feat/v0.9.0-tx-flight-react`
- 12 verified commits, plus a 13th release-prep commit (synced version
  bump + CHANGELOGs)
- Merged to `main` with `git merge --no-ff` per the
  `workflow_no_prs.md` memory.
- Pre-tag step: **manual first-publish of `@valve-tech/tx-flight-react`
  from a maintainer's machine** (claims the npm name, lets us
  configure the OIDC trusted-publisher record). See §13.
- After trusted-publisher record is in place: signed `v0.9.0` tag.
  OIDC workflow publishes all six packages in lockstep.

---

## Task 1 — package scaffolding

Create `packages/tx-flight-react/` with the standard valve-tech package
shape. No source code yet — just a building, importable, empty
package.

**Files:**

```
packages/tx-flight-react/
├── package.json                # name, version 0.0.0 (bumps to 0.9.0 at release), peer deps, scripts
├── tsconfig.json               # extends ../../tsconfig.base.json, jsx: 'react-jsx'
├── vitest.config.ts            # jsdom default; happy-dom for storage suite; node for SSR suite
├── eslint.config.js            # extends root, adds react-hooks rules
├── README.md                   # stub
├── AGENTS.md                   # stub
├── CHANGELOG.md                # stub with v0.9.0 placeholder
└── src/
    └── index.ts                # empty barrel
```

**`package.json` skeleton:**

```json
{
  "name": "@valve-tech/tx-flight-react",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./storage": "./dist/storage/index.js"
  },
  "files": ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
  "sideEffects": false,
  "peerDependencies": {
    "react": "^18.2.0 || ^19.0.0",
    "react-dom": "^18.2.0 || ^19.0.0",
    "viem": "^2.21.0"
  },
  "peerDependenciesMeta": {
    "@valve-tech/wallet-adapter": { "optional": true },
    "@valve-tech/tx-tracker": { "optional": true }
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "fake-indexeddb": "^6.0.0",
    "happy-dom": "^15.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "scripts": {
    "build": "tsc -p .",
    "typecheck": "tsc -p . --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src"
  }
}
```

**Verification:** `corepack yarn install --immutable` succeeds. The
empty package builds and types-checks. No test files yet, so the
coverage gate isn't applicable on this commit.

**Commit:** `chore(tx-flight-react): scaffold new React package`

---

## Task 2 — core types + re-exports

Add the foundational type surface — `AddWithWalletAdapterInput`,
`AddByHashInput`, `AddManualInput`, `TxFlightStorage`, re-export
`TrackedTx` / `TX_STATUS` / `TX_FLOW` from
`@valve-tech/wallet-adapter`. No runtime code yet — just types.

**Files:**

```
src/
├── types.ts                    # 3 input types, TxFlightStorage, internal state types
└── index.ts                    # public type re-exports
```

`types.ts` contents (reference; full shapes in spec §3.3, §3.5):

```ts
import type { Hex, PublicClient } from 'viem'
import type {
  TrackedTx,
  TX_STATUS,
  TX_FLOW,
  TxFlowKey,
  WriteHookParams,
  WalletSendTransactionRequest,
} from '@valve-tech/wallet-adapter'

export type { TrackedTx, TxFlowKey }
export { TX_STATUS, TX_FLOW }

export interface AddWithWalletAdapterInput { /* see spec §3.3 */ }
export interface AddByHashInput { /* see spec §3.3 */ }
export interface AddManualInput { /* see spec §3.3 */ }

export interface TxFlightStorage {
  load(id: string): Promise<TrackedTx[] | null>
  save(id: string, txs: TrackedTx[]): Promise<void>
}
```

Note: `@valve-tech/wallet-adapter` is referenced via `type` imports
only at this stage — these are purely compile-time, so the optional
peer-dep posture holds.

**Verification:**
- `corepack yarn typecheck` clean.
- `corepack yarn lint` clean.
- No tests yet; coverage N/A.

**Commit:** `feat(tx-flight-react): core types + wallet-adapter re-exports`

---

## Task 3 — reducers

Pure functions that fold state changes. Full coverage from this commit
onward.

**Files:**

```
src/
├── store/
│   ├── reducers.ts             # addReducer, updateReducer, removeReducer, evictReducer
│   └── reducers.test.ts
└── ...
```

**Reducer signatures:**

```ts
interface InternalState {
  txs: ReadonlyMap<string, TrackedTx>
  watchers: ReadonlyMap<string, () => void>
}

/**
 * `addReducer` is shape-agnostic — it just inserts a TrackedTx that
 * the caller has already constructed (via the per-method dispatchers
 * in store.ts). Keeping the reducer one-shape lets it stay pure and
 * easy to test.
 */
export const addReducer = (
  state: InternalState,
  tx: TrackedTx,
  watcher: (() => void) | null,
): InternalState

export const updateReducer = (
  state: InternalState,
  txId: string,
  patch: Partial<TrackedTx>,
): InternalState

export const removeReducer = (
  state: InternalState,
  txId: string,
): InternalState

export const evictReducer = (
  state: InternalState,
  opts: { maxItems: number; terminalRetentionMs: number; now: number },
): InternalState
```

**Test surface:**
- `addReducer` inserts a TrackedTx and (optionally) a watcher unsub
  in the watcher map. Idempotent on duplicate ids (overwrites).
- `updateReducer` patches non-existent id is a no-op.
- `removeReducer` drops both the tx and its watcher entry but does
  NOT call the unsub (Provider does that — reducers stay pure).
- `evictReducer` drops terminals older than retention; truncates to
  `maxItems` if still over; preserves non-terminals over terminals
  when both are eligible.

The construction logic that turns each `addWith*Input` into a
`TrackedTx` lives in the dispatcher methods (Tasks 5, 7, 8). The
reducer doesn't know about the three input shapes.

**Verification:** 100/100/100/100 on `reducers.ts`.

**Commit:** `feat(tx-flight-react): pure reducers for add/update/remove/evict`

---

## Task 4 — storage adapters

Three adapters in one commit — they all satisfy the same interface and
share test machinery.

**Files:**

```
src/storage/
├── memory.ts                   # memoryAdapter()
├── memory.test.ts
├── local-storage.ts            # localStorageAdapter()
├── local-storage.test.ts
├── indexed-db.ts               # indexedDBAdapter()
├── indexed-db.test.ts
└── index.ts                    # re-exports
```

**Key behaviors:**

- `memoryAdapter()`: in-process Map. Identity reset between instances.
- `localStorageAdapter({ keyPrefix? })`: storage key
  `${keyPrefix || 'tx-flight'}:${id}`. SSR-safe — when
  `globalThis.window === undefined`, both methods resolve as if no
  data exists (load → null, save → resolved no-op).
  - Bigint values inside `TrackedTx` need a serializer/deserializer.
    Use the same convention as the rest of the toolkit
    (`packages/chain-source/src/wire.ts` style — `0x` hex for bigints
    when serializing to JSON).
- `indexedDBAdapter({ dbName?, storeName? })`: opens a database with
  one object store keyed by `id`. Async API; tests use
  `fake-indexeddb`.

**Test setup:**

`vitest.config.ts` switches environment per-suite:
- Default: `jsdom` (gives `localStorage`).
- Add `// @vitest-environment node` at the top of one file to verify
  the SSR no-window path of `localStorageAdapter`.
- `fake-indexeddb/auto` import in the IndexedDB test file's setup.

**Verification:** 100/100/100/100 across all three adapter files.

**Commit:** `feat(tx-flight-react): storage adapters (memory, localStorage, indexedDB)`

---

## Task 5 — internal store + Provider + hook + manual `via`

Combine the store + Provider + `useTxFlight` + the simplest add
method (`addManual`) into one commit. Reasoning: these primitives
are tightly coupled — the Provider's mount/unmount is what wires
reducers to subscribers, and the hook is the only public surface for
Provider state. Splitting across multiple commits would leave
half-tested intermediates.

**Files:**

```
src/
├── store/
│   ├── store.ts                # useSyncExternalStore-backed store
│   └── store.test.ts
├── provider.tsx                # TxFlightProvider, context
├── provider.test.tsx
├── use-tx-flight.ts            # useTxFlight hook
├── use-tx-flight.test.tsx
└── index.ts                    # exports
```

**Store contract:**

```ts
interface TxFlightStore {
  getState(): InternalState
  subscribe(listener: () => void): () => void
  dispatch: {
    /** Insert a fully-built TrackedTx + optional watcher unsub. */
    addWithTx: (tx: TrackedTx, watcher: (() => void) | null) => void
    update: (txId: string, patch: Partial<TrackedTx>) => void
    remove: (txId: string) => void
    clear: () => void
  }
}

export const createTxFlightStore = (opts: {
  maxItems: number
  terminalRetentionMs: number
  onError?: (method: string, err: unknown) => void
}): TxFlightStore
```

The store dispatch is shape-agnostic — `addWithTx` takes an
already-constructed TrackedTx. The three public `addWith*` /
`addByHash` / `addManual` methods exposed by the hook are thin
adapters over this single low-level dispatch:

- `addManual({ tx })` → `dispatch.addWithTx(tx, null)`
- `addWithWalletAdapter({...})` → builds an initial TrackedTx (status
  `preparing`), wraps the user hooks so each phase calls
  `dispatch.update(id, patch)`, calls `dispatch.addWithTx(tx, null)`,
  returns `{ id, hooks: wrappedHooks }`
- `addByHash({...})` → dynamic-imports tx-tracker, builds a watcher
  that calls `dispatch.update`, calls `dispatch.addWithTx(tx, unsub)`,
  resolves the promise with the id

Manual is the simplest test bed and lands in this commit. The other
two ship in Tasks 7 + 8 respectively.

**Provider contract:**
- One context per `id`. The Provider creates a store on mount,
  registers it under the id in a module-level registry. Two providers
  with the same id share the same store instance (last unmount wipes
  the registry entry).
- Storage adapter is read on mount (rehydrate); state changes trigger
  debounced `save`; unmount flushes a final save synchronously.
- `setInterval` ticks the eviction reducer every 5s.

**Hook contract:**
- `useTxFlight(id?)` reads the store from context (defaults to id `'default'`).
- Throws if no Provider for the requested id is in tree:
  `No <TxFlightProvider id="..."> found`.

**Test surface:**
- Store: every reducer dispatch updates state; subscribers fire.
- Provider: mount/unmount; multiple instances; rehydrate from storage;
  flush on unmount.
- Hook: reads state; throws outside provider; multi-instance scoping.
- `addManual({ tx })` lands in state with the supplied id.

**Coverage caveat:** the eviction `setInterval` makes timer-based
testing unavoidable. Use `vi.useFakeTimers()` and advance manually.

**Verification:** 100/100/100/100 on the new files; whole-package
gate green.

**Commit:** `feat(tx-flight-react): provider, store, useTxFlight hook + manual via`

---

## Task 6 — atomic + layout components

All UI components in one commit. They share rendering conventions and
have no inter-dependencies on the dynamic `via` paths (still pending
in tasks 7-8), so this can land independently.

**Files:**

```
src/
├── components/
│   ├── status-icon.tsx
│   ├── status-icon.test.tsx
│   ├── hash-link.tsx
│   ├── hash-link.test.tsx
│   ├── age.tsx
│   ├── age.test.tsx
│   ├── actions.tsx
│   ├── actions.test.tsx
│   ├── item.tsx                # TxFlightItem
│   ├── item.test.tsx
│   ├── list.tsx                # TxFlightList
│   └── list.test.tsx
└── index.ts                    # add component exports
```

**Notes:**
- `<TxFlightAge>` uses `useEffect` for periodic refresh — mark
  `'use client'`.
- `<TxFlightHashLink>` falls back to plain text when no `explorer` is
  given; covers the no-anchor branch.
- `<TxFlightActions>` renders nothing for unset action callbacks
  (forces consumers to pass handlers, no orphan buttons).

**Test surface:** for each component, smoke-render under
`@testing-library/react`, assert key attributes/text, exercise every
prop branch.

**Verification:** 100/100/100/100 on all component files.

**Commit:** `feat(tx-flight-react): atomic + layout components`

---

## Task 7 — wallet-adapter integration (`addWithWalletAdapter`)

Wire up the `addWithWalletAdapter(input)` path. Returns `{ id, hooks }`
so the consumer pipes the wrapped hooks straight into
`sendTransactionWithHooks`.

**Files:**

```
src/integrations/
├── wallet-adapter.ts           # wrapHooks, addWithWalletAdapterImpl
└── wallet-adapter.test.ts
```

**Implementation:**
- `wrapHooks(userHooks, store, txId): WriteHookParams` returns a new
  hooks bag where every named callback (and `onPhase`) fans out to
  both the user's original callback AND a store dispatch.
- `addWithWalletAdapterImpl(store, input): { id, hooks }` builds the
  initial TrackedTx (status `preparing`), calls `store.dispatch.addWithTx`,
  and returns the wrapped hooks. Wired into the hook returned by
  `useTxFlight`.

**Imports:**
- Static `import type { WriteHookParams } from '@valve-tech/wallet-adapter'`
  is fine (type-only).
- The runtime values (TX_STATUS, etc.) are also already loaded via the
  `index.ts` re-exports, which itself is a static import. Since
  wallet-adapter is an optional peer, this means consumers who DON'T
  use the wallet-adapter path still get the dependency loaded… we
  resolve this by re-exporting only types (see Task 2) and accepting
  that the `wallet-adapter` runtime values used here are the same
  ones the consumer is already pulling. **No dynamic import for this
  shape.**
- For `addByHash` (Task 8), tx-tracker IS dynamic-imported because
  the package can ship without tx-tracker for callers who only ever
  use the wallet-adapter path.

**Test surface:**
- Stub WriteHookParams with `vi.fn()`s for every callback.
- Drive each phase by invoking the wrapped hooks directly.
- Assert: original callback fired AND store updated with correct
  status.
- Edge cases: undefined user callbacks (should still update store);
  user callback that throws (should not break store update).

**Verification:** 100/100/100/100. Add `@valve-tech/wallet-adapter` to
the package's optional peer deps if not already there.

**Commit:** `feat(tx-flight-react): wallet-adapter integration with hook fan-out`

---

## Task 8 — tx-tracker integration (`addByHash`)

Wire up the `addByHash(input)` path. Dynamic-imports
`@valve-tech/tx-tracker` and `@valve-tech/chain-source` so callers
who never use this method don't pay the bundle cost. The dynamic
import is what makes `addByHash` async (`Promise<string>`).

**Files:**

```
src/integrations/
├── tx-tracker.ts               # addByHashImpl, lazy import of tx-tracker
└── tx-tracker.test.ts
```

**Implementation:**
```ts
const addByHashImpl = async (
  store: TxFlightStore,
  input: AddByHashInput,
): Promise<string> => {
  const { createChainSource } = await import('@valve-tech/chain-source')
  const { createTxTracker } = await import('@valve-tech/tx-tracker')
  // build private ChainSource + TxTracker
  // tracker.subscribe(input.hash, cb, { withReceipts: input.withReceipts })
  // cb routes every event to store.dispatch.update(txId, patch)
  // build initial TrackedTx (status: pending), call dispatch.addWithTx(tx, unsub)
  return txId
}
```

Method-name self-document means there's no overload juggling. The
hook surface has three distinct methods, each with one return type.

**Test surface:**
- `_sourceOverride` injection seam (mirrors the pattern from
  `packages/tx-tracker/src/watch-transaction.test.ts`).
- Drive `pending` → `mined`, `pending` → `replaced`, `pending` →
  `dropped`, `pending` → `failed` (with receipts).
- Assert teardown cancels watcher subscription on `remove()`.

**Verification:** 100/100/100/100.

**Commit:** `feat(tx-flight-react): tx-tracker integration via dynamic import`

---

## Task 9 — persistence + rehydrate

The Provider already wires `load`/`save` (Task 5). This task:
1. Adds the rehydrate-on-mount logic to re-issue watchers for
   non-terminal entries.
2. Adds the bigint-safe JSON serializer.
3. Tests the failure modes (storage throws on load → fall back to
   empty; storage throws on save → onError fires, state is intact).

**Files:**

```
src/
├── store/
│   ├── serialize.ts            # bigintToHex / hexToBigint pair, TrackedTx-aware
│   └── serialize.test.ts
├── provider.tsx                # add rehydrate logic
└── ...
```

**Rehydrate semantics (matches spec §4.5):**
- `pending` with `hash` set: re-invoke `addByHashImpl` internally to
  resume watching (no public `addByHash` round-trip needed; we
  already have the input shape).
- `awaitingSignature` (no hash): drop to `failed` with `notes:
  'lost during reload'`. Rationale: we can't resume a wallet
  interaction across reloads.

**Test surface:**
- Round-trip serialize/deserialize a TrackedTx with bigint fields.
- Mount Provider with a pre-populated storage adapter; assert state
  rehydrates and watchers re-arm for pending entries.
- Storage `load` throws → state defaults to empty, `onError` fired.
- Storage `save` throws → state still consistent, `onError` fired.

**Verification:** 100/100/100/100.

**Commit:** `feat(tx-flight-react): persistence + rehydrate with watcher revival`

---

## Task 10 — eviction + terminal retention

`evictReducer` was added in Task 3. This task wires it into the
Provider's `setInterval` tick and tests the integrated behavior.

**Files:**

```
src/
└── provider.tsx                # add eviction interval
```

**Test surface:**
- Mount Provider, add 5 entries, mark them terminal, advance fake
  timers past `terminalRetentionMs` + tick interval, assert pruned.
- `maxItems` enforcement: add 51 entries, assert exactly 50 remain
  after eviction tick.
- `clearInterval` called on unmount.

**Verification:** 100/100/100/100.

**Commit:** `feat(tx-flight-react): periodic eviction with terminal retention`

---

## Task 11 — examples + README + AGENTS.md

Three minimal, working examples in `examples/`, full README + AGENTS.

**Files:**

```
examples/
├── 11-tx-flight-react-minimal/
│   ├── App.tsx                 # Provider + List + add() from a button
│   ├── index.html
│   ├── package.json
│   └── tsconfig.json
└── 12-tx-flight-react-multi-instance/
    ├── App.tsx                 # two Providers, two strips, isolated
    ├── ...

packages/tx-flight-react/
├── README.md                   # API ref, examples, peer-dep matrix
├── AGENTS.md                   # contributor notes (mirrors gas-oracle/AGENTS.md style)
└── CHANGELOG.md                # v0.9.0 entry (placeholder until release commit)
```

The README includes:
- 30-second quickstart
- Full export table (mirrors wallet-adapter/README.md pattern)
- Each `via` shape with a working example
- Storage adapter swap example
- SSR / RSC notes

**Verification:** examples typecheck via the existing
`yarn typecheck:examples` script (extend it to cover the new
examples directories if needed).

**Commit:** `docs(tx-flight-react): examples + README + AGENTS`

---

## Task 12 — SSR safety verification

Audit every code path for `window` / `document` access; gate behind
`typeof globalThis.window !== 'undefined'`. Add one vitest suite
under `// @vitest-environment node` that imports the package and
mounts (without `<TxFlightProvider>`'s storage doing real work) to
prove SSR doesn't crash.

**Files:**

```
src/
└── ssr.test.ts                 # @vitest-environment node
```

**Test surface:**
- Import `@valve-tech/tx-flight-react` and every named export — no
  `ReferenceError` from `window`.
- `localStorageAdapter()` instantiated under node environment:
  `load()` returns null, `save()` resolves.
- `<TxFlightProvider>` rendered to string via `react-dom/server`'s
  `renderToString` — produces deterministic output.

**Coverage notes:** the `typeof window === 'undefined'` branches are
exercised by this suite. No `c8 ignore` needed.

**Verification:** 100/100/100/100 across the package, including the
SSR path. Whole-workspace gate green.

**Commit:** `feat(tx-flight-react): SSR + RSC safety verification`

---

## Task 13 — release prep (synced bump + CHANGELOGs)

Pre-tag commit. Bump every package to `0.9.0`, update each
`packages/*/CHANGELOG.md` and the root `CHANGELOG.md`.

**Files:**

```
packages/chain-source/package.json        0.8.1 → 0.9.0
packages/gas-oracle/package.json          0.8.1 → 0.9.0
packages/tx-tracker/package.json          0.8.1 → 0.9.0
packages/viem-errors/package.json         0.8.1 → 0.9.0
packages/wallet-adapter/package.json      0.8.1 → 0.9.0
packages/tx-flight-react/package.json     0.0.0 → 0.9.0
packages/chain-source/CHANGELOG.md        + [0.9.0] (synced no-op)
packages/gas-oracle/CHANGELOG.md          + [0.9.0] (synced no-op)
packages/tx-tracker/CHANGELOG.md          + [0.9.0] (synced no-op)
packages/viem-errors/CHANGELOG.md         + [0.9.0] (synced no-op)
packages/wallet-adapter/CHANGELOG.md      + [0.9.0] (synced no-op)
packages/tx-flight-react/CHANGELOG.md     + [0.9.0] full entry
CHANGELOG.md                              + [0.9.0] highlight tx-flight-react
```

**Verification:** full-workspace gate green; every package's
package.json `version` matches the tag we'll create (`v0.9.0`).

**Commit:** `chore(release): v0.9.0 — tx-flight-react React UI package lands`

---

## Post-merge: first-publish dance + tag

After `feat/v0.9.0-tx-flight-react` merges to main with `--no-ff`:

### §13.1 First-publish dance for `@valve-tech/tx-flight-react`

Run from a maintainer's machine, on the merged main:

```bash
corepack yarn workspace @valve-tech/tx-flight-react build
cd packages/tx-flight-react
npm pack --dry-run                     # verify only dist/, README, LICENSE, CHANGELOG
npm whoami                             # logged in as a @valve-tech maintainer
npm publish --access public            # claims the npm name
cd ../..
```

Then at https://www.npmjs.com/settings/valve-tech/publishing, add a
trusted-publisher record:

| Field | Value |
|---|---|
| Package | `@valve-tech/tx-flight-react` |
| Publisher | GitHub Actions |
| Repository owner | `valve-tech` |
| Repository name | `evm-toolkit` |
| Workflow filename | `release.yml` |
| Environment | *(blank)* |

### §13.2 Tag + push

```bash
git tag -s v0.9.0 -m "v0.9.0 — tx-flight-react React UI package"
git push origin v0.9.0
```

OIDC release workflow runs. **Note:** the tag-driven publish will
re-publish the same `@valve-tech/tx-flight-react@0.9.0` that was
manually published in §13.1. npm rejects this. Workaround: bump
`tx-flight-react` to `0.9.1` for the synced tag-driven release, or
bump everything to `0.9.1` from the start. Decision deferred to
release time.

**Recommended: skip the manual first-publish at 0.9.0.** Instead:
1. Manual-publish `@valve-tech/tx-flight-react@0.0.1` from the
   merged main BEFORE the version-bump commit. This claims the npm
   name and lets us configure the trusted-publisher record.
2. Then proceed with the synced bump to `0.9.0` and the OIDC tag-
   driven release. The workflow publishes `0.9.0` for all six
   packages, which is a fresh version for tx-flight-react.

This is the safer flow. Adjust the release-prep commit timing
accordingly.

### §13.3 Verify publish

```bash
for pkg in chain-source gas-oracle tx-tracker viem-errors wallet-adapter tx-flight-react; do
  echo -n "@valve-tech/$pkg "
  npm view "@valve-tech/$pkg@latest" version
done
```

All six should print `0.9.0`.

---

## Architectural decisions ratified during planning

- **Single mega-PR shape** — same as v0.8.0. One branch, 12 verified
  commits, one release commit, one signed tag.
- **Three named methods (`addWithWalletAdapter`, `addByHash`,
  `addManual`) instead of one `add(input)` with a discriminated
  union** — each method has a single, predictable return type
  (`{ id, hooks }`, `Promise<string>`, `string`). Avoids the
  one-method-three-return-shapes API smell. Method names also
  self-document the integration shape (no `via:` field for users to
  inspect).
- **Reducers in their own module + tested as pure functions** —
  same discipline as `decideBlockObservation` in tx-tracker. Forces
  the side-effecty Provider logic to be thin. The reducer is shape-
  agnostic; per-method dispatchers turn each input into a TrackedTx
  before reaching the reducer.
- **Provider + hook + store + manual integration in one commit** —
  they're too coupled to test independently.
- **Components in one commit** — they don't depend on the
  wallet-adapter / tx-tracker integrations and share rendering
  conventions; landing them together saves three round-trips of test
  setup.
- **Dynamic-import the tx-tracker integration** — keeps the bundle
  payload off the wallet-adapter-only consumer path. Mirrors the
  `peerDependenciesMeta.optional` posture. This is what makes
  `addByHash` async (the only async method on the hook).
- **No `c8 ignore` annotations** — apply v0.8.x cleanup discipline
  from day 1. If a code path can't be exercised, refactor or delete.
- **Manual first-publish at 0.0.1, synced tag-driven at 0.9.0** — the
  cleanest interaction with the OIDC trusted-publisher record (see
  §13.2).

---

## Risk register (carry into execution)

- **React peer-dep matrix.** React 19 is current (Jan 2026 cutoff
  knowledge); React 18 is still widely deployed. The `^18 || ^19`
  range covers both. If a 19-only API leaks into the implementation
  (unlikely — we use only `useState`/`useEffect`/`useSyncExternalStore`/
  `useContext`), tighten the range and document.
- **`@testing-library/react` for React 19.** v16+ supports both. Use
  v16.0.0 or later.
- **Storage rehydrate watcher revival.** If a consumer reloads with
  100 pending entries, we'd spawn 100 ChainSource+TxTracker pairs.
  Mitigation: rehydrate caps at `maxItems`; non-pending entries
  rehydrate without watchers.
- **Bigint serialization.** `JSON.stringify` rejects bigints. The
  serialize.ts module handles this. Audit every `TrackedTx` field at
  Task 9 to ensure no untreated bigint slips through.
- **SSR + dynamic imports.** Next.js / Remix RSC shouldn't try to
  evaluate the tx-tracker dynamic import on the server. The Provider
  is `'use client'`; the dynamic imports happen inside dispatch
  callbacks, not at module top level. Verified by Task 12's SSR
  suite.
