/**
 * Variant accessors for `/chunks`. Unlike most chifra endpoints,
 * `/chunks` selects its output via a `mode` enum (not boolean
 * flags). The seven mode-preselect variants cover the Go SDK's
 * `ChunksList` (= `mode=index`) and `ChunksPinsList` (= `mode=pins`)
 * directly. The two modifier variants below — `count` (returns
 * `Count[]`) and `check` (returns `ReportCheck[]`) — cover the Go
 * SDK's `ChunksCount` and `ChunksDiff`. Callers still pass `mode`
 * with these two; the variant just narrows the return type.
 */
import type { RequestFn } from '../client.js'
import type { components } from '../generated.js'
import { makeVerb, type Query, type VerbFn } from '../verbs.js'

type ChunksQuery = Query<'/chunks'>
type Envelope<T> = { data?: T[] }

export interface ChunksVerb extends VerbFn<'/chunks'> {
  /** `?mode=manifest` — the chain manifest. */
  manifest: (
    query: Omit<ChunksQuery, 'mode'>,
  ) => Promise<Envelope<components['schemas']['manifest']>>
  /** `?mode=index` — index chunk records. */
  index: (
    query: Omit<ChunksQuery, 'mode'>,
  ) => Promise<Envelope<components['schemas']['chunkIndex']>>
  /** `?mode=blooms` — bloom filter chunks. */
  blooms: (
    query: Omit<ChunksQuery, 'mode'>,
  ) => Promise<Envelope<components['schemas']['chunkBloom']>>
  /** `?mode=pins` — pinned chunks. */
  pins: (
    query: Omit<ChunksQuery, 'mode'>,
  ) => Promise<Envelope<components['schemas']['chunkPin']>>
  /** `?mode=addresses` — addresses contained in the chunk(s). */
  addresses: (
    query: Omit<ChunksQuery, 'mode'>,
  ) => Promise<Envelope<components['schemas']['chunkAddress']>>
  /** `?mode=appearances` — appearance entries within chunks. */
  appearances: (
    query: Omit<ChunksQuery, 'mode'>,
  ) => Promise<Envelope<components['schemas']['appearanceTable']>>
  /** `?mode=stats` — chunk statistics. */
  stats: (
    query: Omit<ChunksQuery, 'mode'>,
  ) => Promise<Envelope<components['schemas']['chunkStats']>>
  /**
   * `?count=true` — record count only. Caller still picks `mode`;
   * the spec notes count works for some modes (manifest/index/pins).
   */
  count: (
    query: Omit<ChunksQuery, 'count'>,
  ) => Promise<Envelope<components['schemas']['count']>>
  /**
   * `?check=true` — internal-consistency check on the manifest,
   * index, or blooms. Caller picks the relevant `mode` and gets
   * back a `ReportCheck[]` instead of the polymorphic chunks union.
   */
  check: (
    query: Omit<ChunksQuery, 'check'>,
  ) => Promise<Envelope<components['schemas']['reportCheck']>>
}

type ChunkMode = ChunksQuery extends { mode: infer M } ? M : never

export function makeChunksVerb(request: RequestFn): ChunksVerb {
  const base = makeVerb(request, '/chunks')

  const variant = (mode: ChunkMode) =>
    (query: Omit<ChunksQuery, 'mode'>) =>
      base({ ...(query as ChunksQuery), mode }) as Promise<unknown>

  const flag = <K extends 'count' | 'check'>(key: K) =>
    (query: Omit<ChunksQuery, K>) =>
      base({ ...(query as ChunksQuery), [key]: true }) as Promise<unknown>

  return Object.assign(base, {
    manifest: variant('manifest'),
    index: variant('index'),
    blooms: variant('blooms'),
    pins: variant('pins'),
    addresses: variant('addresses'),
    appearances: variant('appearances'),
    stats: variant('stats'),
    count: flag('count'),
    check: flag('check'),
  }) as ChunksVerb
}
