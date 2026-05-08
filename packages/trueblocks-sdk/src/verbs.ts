import type { RequestFn } from './client.js'
import type { paths } from './generated.js'

/**
 * Extracts the query-parameter type for a given chifra endpoint
 * from the generated OpenAPI types. The `query?: infer Q` form
 * matches both required (`query: { … }`) and optional (`query?: { … }`)
 * spec definitions, returning the inner object type either way.
 */
export type Query<P extends keyof paths> = paths[P]['get'] extends {
  parameters: { query?: infer Q }
}
  ? Q
  : never

/**
 * True at type level when a chifra endpoint's `query` parameter is
 * required (the OpenAPI spec did not mark it optional). Used to
 * narrow `VerbFn<P>` to a required-arg signature for endpoints like
 * `/blocks` (which mandates `blocks: string[]`) while keeping a
 * no-arg-allowed signature for endpoints like `/status`.
 */
export type IsRequiredQuery<P extends keyof paths> = paths[P]['get'] extends {
  parameters: { query: unknown }
}
  ? true
  : false

/**
 * Extracts the JSON response body type for a given chifra endpoint.
 */
export type Response<P extends keyof paths> = paths[P]['get'] extends {
  responses: { 200: { content: { 'application/json': infer R } } }
}
  ? R
  : never

/**
 * The callable signature of a verb. Distinguishes endpoints whose
 * `query` is required (call MUST pass an arg, e.g. `client.blocks({ blocks: [...] })`)
 * from those whose `query` is optional (call MAY omit the arg, e.g.
 * `client.status()`). Required fields inside the query object remain
 * required regardless.
 */
export type VerbFn<P extends keyof paths> =
  IsRequiredQuery<P> extends true
    ? (query: Query<P>) => Promise<Response<P>>
    : (query?: Query<P>) => Promise<Response<P>>

/**
 * Builds a typed verb-method for a chifra endpoint. The runtime is
 * uniform — `query` is always passed through to `request` whether
 * provided or undefined — but the public type narrows to required
 * vs optional based on the spec.
 */
export function makeVerb<P extends keyof paths>(
  request: RequestFn,
  path: P,
): VerbFn<P> {
  const fn = async (query?: unknown): Promise<Response<P>> => {
    return request<Response<P>>(
      path,
      query as Record<string, unknown> | undefined,
    )
  }
  return fn as VerbFn<P>
}

/**
 * Returns the full chifra verb surface, one method per OpenAPI path.
 * Each method is typed against its endpoint's parameters and
 * response. JSDoc on each property surfaces the chifra description
 * in editor tooltips.
 */
export function createVerbs(request: RequestFn) {
  return {
    /**
     * `GET /list` — list every appearance of an address (or
     * addresses) anywhere on the chain. Mirrors `chifra list`.
     */
    list: makeVerb(request, '/list'),

    /**
     * `GET /export` — export full transaction details for one or
     * more monitored addresses. Mirrors `chifra export`.
     */
    export: makeVerb(request, '/export'),

    /**
     * `GET /monitors` — manage and inspect address monitors. Mirrors
     * `chifra monitors`.
     */
    monitors: makeVerb(request, '/monitors'),

    /**
     * `GET /names` — query and manage address-to-name mappings.
     * Mirrors `chifra names`.
     */
    names: makeVerb(request, '/names'),

    /**
     * `GET /abis` — fetch ABIs for known contracts. Mirrors
     * `chifra abis`.
     */
    abis: makeVerb(request, '/abis'),

    /**
     * `GET /blocks` — retrieve one or more blocks from chain or
     * local cache. Polymorphic response: depending on flags
     * (`logs`, `traces`, `withdrawals`, `uniq`, …) returns blocks,
     * logs, traces, withdrawals, or appearances. Mirrors `chifra
     * blocks`.
     */
    blocks: makeVerb(request, '/blocks'),

    /**
     * `GET /transactions` — retrieve one or more transactions by
     * hash, block.txid, or block.address. Mirrors `chifra
     * transactions`.
     */
    transactions: makeVerb(request, '/transactions'),

    /**
     * `GET /receipts` — retrieve receipts for one or more
     * transactions. Mirrors `chifra receipts`.
     */
    receipts: makeVerb(request, '/receipts'),

    /**
     * `GET /logs` — retrieve event logs for one or more
     * transactions. Mirrors `chifra logs`.
     */
    logs: makeVerb(request, '/logs'),

    /**
     * `GET /traces` — retrieve execution traces for one or more
     * transactions. Mirrors `chifra traces`.
     */
    traces: makeVerb(request, '/traces'),

    /**
     * `GET /when` — block-by-time / block-by-date queries; map
     * timestamps and named events to block numbers. Mirrors
     * `chifra when`.
     */
    when: makeVerb(request, '/when'),

    /**
     * `GET /state` — read account state at a block (balance, nonce,
     * code, storage). Mirrors `chifra state`.
     */
    state: makeVerb(request, '/state'),

    /**
     * `GET /tokens` — read token balances for accounts at given
     * block(s). Mirrors `chifra tokens`.
     */
    tokens: makeVerb(request, '/tokens'),

    /**
     * `GET /config` — daemon configuration; read effective settings
     * or list known chains. Mirrors `chifra config`.
     */
    config: makeVerb(request, '/config'),

    /**
     * `GET /status` — daemon health and per-cache status. Mirrors
     * `chifra status`.
     */
    status: makeVerb(request, '/status'),

    /**
     * `GET /chunks` — manage and inspect index chunks. Mirrors
     * `chifra chunks`.
     */
    chunks: makeVerb(request, '/chunks'),

    /**
     * `GET /init` — initialize the daemon's index by downloading
     * pinned chunks. Mirrors `chifra init`.
     */
    init: makeVerb(request, '/init'),

    /**
     * `GET /slurp` — fetch transactions for an address from a
     * 3rd-party source (e.g. Etherscan). Mirrors `chifra slurp`.
     */
    slurp: makeVerb(request, '/slurp'),
  }
}

export type Verbs = ReturnType<typeof createVerbs>
