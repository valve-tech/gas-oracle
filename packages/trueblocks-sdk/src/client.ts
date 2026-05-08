import { TrueblocksError } from './errors.js'
import type { paths } from './generated.js'
import { createVerbs, type Verbs } from './verbs.js'

export type FetchFn = typeof globalThis.fetch

export interface CreateTrueblocksClientOptions {
  /**
   * Base URL of the chifra daemon, e.g. `'http://localhost:8080'`.
   * A trailing slash is allowed and stripped.
   */
  baseUrl: string
  /**
   * Optional fetch override. Defaults to `globalThis.fetch`. Useful
   * for tests, custom transports, or environments that need to wrap
   * the fetch call (auth headers, retry, instrumentation).
   */
  fetch?: FetchFn
}

/**
 * Internal request function used by every verb. Verbs are pure
 * factories that take this and return their typed callable — tests
 * inject a mock to exercise verb logic without hitting fetch.
 */
export type RequestFn = <R>(
  path: keyof paths,
  query?: Record<string, unknown>,
) => Promise<R>

export type TrueblocksClient = Verbs

export function createTrueblocksClient(
  options: CreateTrueblocksClientOptions,
): TrueblocksClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const fetchFn = options.fetch ?? globalThis.fetch

  const request: RequestFn = async <R>(
    path: keyof paths,
    query?: Record<string, unknown>,
  ): Promise<R> => {
    const url = new URL(baseUrl + (path as string))
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, String(item))
        } else {
          url.searchParams.set(key, String(value))
        }
      }
    }

    let response: Response
    try {
      response = await fetchFn(url.toString())
    } catch (err) {
      throw new TrueblocksError(
        `chifra request to ${path as string} failed: ${(err as Error).message}`,
        { path: path as string, cause: err },
      )
    }

    if (!response.ok) {
      throw new TrueblocksError(
        `chifra ${path as string} returned ${response.status} ${response.statusText}`,
        { path: path as string, status: response.status },
      )
    }

    return response.json() as Promise<R>
  }

  return createVerbs(request)
}
