import type { TxPoolContent } from '@valve-tech/chain-source'
import { describe, expect, it } from 'vitest'

import {
  findByAddressNonce,
  findByHash,
  findInMempool,
  normalizeMempool,
} from './mempool.js'

const tx = (
  overrides: Partial<{
    hash: string
    type: string
    gas: string
    nonce: string
    from: string
  }>,
) => ({
  gasPrice: '0x3b9aca00',
  gas: '0x5208',
  type: '0x0',
  ...overrides,
})

// Raw upstream pool — note checksummed sender addresses and hex-form
// nonce keys. `normalizeMempool` is what callers feed into the lookup
// helpers; this fixture round-trips through it.
const rawPool: TxPoolContent = {
  pending: {
    '0xAaAaAa1111111111111111111111111111111111': {
      '0x3': tx({ hash: '0xpending3', nonce: '0x3' }),
      '0x4': tx({ hash: '0xpending4', nonce: '0x4' }),
    },
    '0xBbBbbb2222222222222222222222222222222222': {
      '0x0': tx({ hash: '0xpendingother', nonce: '0x0' }),
    },
  },
  queued: {
    '0xAaAaAa1111111111111111111111111111111111': {
      '0x7': tx({ hash: '0xqueued7', nonce: '0x7' }),
    },
  },
}

const pool = normalizeMempool(rawPool)

describe('normalizeMempool', () => {
  it('lowercases sender address keys in both subpools', () => {
    const keys = Object.keys(pool.pending)
    for (const k of keys) {
      expect(k).toBe(k.toLowerCase())
    }
    const queuedKeys = Object.keys(pool.queued)
    for (const k of queuedKeys) {
      expect(k).toBe(k.toLowerCase())
    }
  })

  it('decimalizes hex nonce keys', () => {
    const aaaa = pool.pending['0xaaaaaa1111111111111111111111111111111111']
    expect(aaaa).toBeDefined()
    expect(Object.keys(aaaa).sort()).toEqual(['3', '4'])
  })

  it('returns an empty NormalizedMempool for null input (not null itself)', () => {
    const empty = normalizeMempool(null)
    expect(empty.pending).toEqual({})
    expect(empty.queued).toEqual({})
  })

  it('is idempotent — re-normalizing produces an equivalent shape', () => {
    const twice = normalizeMempool(pool)
    expect(twice).toEqual(pool)
  })
})

describe('findByHash', () => {
  it('returns null for null/empty pool input', () => {
    expect(findByHash(null, '0xpending3')).toBeNull()
    expect(findByHash(undefined, '0xpending3')).toBeNull()
    expect(findByHash({ pending: {}, queued: {} }, '0xpending3')).toBeNull()
  })

  it('returns null when hash is not found', () => {
    expect(findByHash(pool, '0xnotpresent')).toBeNull()
  })

  it('finds a pending tx and reports the bucket as pending', () => {
    const hit = findByHash(pool, '0xpending3')
    expect(hit).not.toBeNull()
    expect(hit!.bucket).toBe('pending')
    expect(hit!.nonce).toBe('3')
    expect(hit!.address).toBe('0xaaaaaa1111111111111111111111111111111111')
  })

  it('finds a queued tx and reports the bucket as queued', () => {
    const hit = findByHash(pool, '0xqueued7')
    expect(hit).not.toBeNull()
    expect(hit!.bucket).toBe('queued')
    expect(hit!.nonce).toBe('7')
  })

  it('matches case-insensitively on hash (tx fields not pre-normalized)', () => {
    const hit = findByHash(pool, '0xPENDING3')
    expect(hit).not.toBeNull()
    expect(hit!.tx.hash).toBe('0xpending3')
  })

  it('returns null when hash arg is empty string', () => {
    expect(findByHash(pool, '')).toBeNull()
  })
})

describe('findByAddressNonce', () => {
  const aaaa = '0xaaaaaa1111111111111111111111111111111111'

  it('returns null for null/empty pool input', () => {
    expect(findByAddressNonce(null, aaaa, 0)).toBeNull()
    expect(findByAddressNonce({ pending: {}, queued: {} }, aaaa, 0)).toBeNull()
  })

  it('finds a pending tx by lowercase address + numeric nonce', () => {
    const hit = findByAddressNonce(pool, aaaa, 3)
    expect(hit).not.toBeNull()
    expect(hit!.bucket).toBe('pending')
    expect(hit!.tx.hash).toBe('0xpending3')
  })

  it('lowercases a checksummed address arg before lookup', () => {
    const hit = findByAddressNonce(
      pool,
      '0xAaAaAa1111111111111111111111111111111111',
      4,
    )
    expect(hit).not.toBeNull()
    expect(hit!.tx.hash).toBe('0xpending4')
  })

  it('decimalizes a hex-string nonce arg', () => {
    const hit = findByAddressNonce(pool, aaaa, '0x3')
    expect(hit).not.toBeNull()
    expect(hit!.tx.hash).toBe('0xpending3')
  })

  it('accepts a bigint nonce arg', () => {
    const hit = findByAddressNonce(pool, aaaa, 4n)
    expect(hit).not.toBeNull()
    expect(hit!.tx.hash).toBe('0xpending4')
  })

  it('falls through to queued when nonce is not in pending for that address', () => {
    const hit = findByAddressNonce(pool, aaaa, 7)
    expect(hit).not.toBeNull()
    expect(hit!.bucket).toBe('queued')
    expect(hit!.tx.hash).toBe('0xqueued7')
  })

  it('returns null when address has no entries in either subpool', () => {
    expect(
      findByAddressNonce(
        pool,
        '0xcccccc3333333333333333333333333333333333',
        0,
      ),
    ).toBeNull()
  })

  it('returns null when address present but nonce not present', () => {
    expect(findByAddressNonce(pool, aaaa, 99)).toBeNull()
  })
})

describe('findInMempool', () => {
  const aaaa = '0xaaaaaa1111111111111111111111111111111111'

  it('routes hash queries through findByHash', () => {
    expect(findInMempool(pool, { hash: '0xpending3' })?.tx.hash).toBe('0xpending3')
  })

  it('routes address+nonce queries through findByAddressNonce', () => {
    expect(findInMempool(pool, { address: aaaa, nonce: 3 })?.tx.hash).toBe('0xpending3')
  })

  it('returns null when pool has no pending OR no queued bucket (searchSubpool guard)', () => {
    // Drives the `if (!subpool) return null` guard in searchSubpool.
    // A malformed snapshot lacking either bucket key still
    // resolves cleanly to null instead of throwing.
    const noPending = { queued: {} } as unknown as Parameters<typeof findByHash>[0]
    expect(findByHash(noPending, '0xanything')).toBeNull()
    const noQueued = { pending: {} } as unknown as Parameters<typeof findByHash>[0]
    expect(findByHash(noQueued, '0xanything')).toBeNull()
  })
})
