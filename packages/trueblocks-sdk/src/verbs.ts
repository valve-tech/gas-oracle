import type { RequestFn } from './client.js'
import type { paths } from './generated.js'

/**
 * Extracts the query-parameter type for a given chifra endpoint
 * from the generated OpenAPI types. Resolves to the inner shape if
 * the endpoint defines query params, or `undefined` if not.
 */
export type Query<P extends keyof paths> = paths[P]['get'] extends {
  parameters: { query?: infer Q }
}
  ? Q
  : never

/**
 * Extracts the JSON response body type for a given chifra endpoint.
 */
export type Response<P extends keyof paths> = paths[P]['get'] extends {
  responses: { 200: { content: { 'application/json': infer R } } }
}
  ? R
  : never

/**
 * Builds a typed verb-method for a chifra endpoint. The returned
 * function takes the endpoint's query params (typed from the spec)
 * and returns a Promise of the typed JSON response body.
 *
 * Optional vs required query is collapsed at the function boundary:
 * the signature takes `query?` for ergonomics, with required fields
 * still surfaced inside the query object's type. Calling with a
 * missing required field will reach chifra and return a typed
 * `TrueblocksError` with the daemon's 4xx status.
 */
export function makeVerb<P extends keyof paths>(request: RequestFn, path: P) {
  return async (query?: Query<P>): Promise<Response<P>> => {
    return request<Response<P>>(
      path,
      query as Record<string, unknown> | undefined,
    )
  }
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
