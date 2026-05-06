import { describe, it, expect } from 'vitest'
import { getUserFriendlyErrorMessage, DEFAULT_ERROR_PATTERNS } from './messages.js'

describe('getUserFriendlyErrorMessage', () => {
  describe('wallet rejection', () => {
    it('always returns the rejection copy first, never falls into other branches', () => {
      // Even if the message contains "execution reverted", a 4001 cause means
      // the user cancelled and the UI should treat it as a rejection.
      const e = Object.assign(new Error('execution reverted'), { cause: { code: 4001 } })
      expect(getUserFriendlyErrorMessage(e)).toMatch(/cancelled/i)
    })
  })

  describe('decoded custom Solidity error', () => {
    it('uses the custom-error map when provided and includes the error name in parens', () => {
      const e = { data: { errorName: 'InsufficientLiquidity' } }
      expect(
        getUserFriendlyErrorMessage(e, {
          customErrors: { InsufficientLiquidity: 'Not enough liquidity for this trade.' },
        }),
      ).toBe('Not enough liquidity for this trade. (InsufficientLiquidity)')
    })

    it('falls back to a humanised version of the error name when not in the map', () => {
      const e = { data: { errorName: 'HashMismatch' } }
      expect(getUserFriendlyErrorMessage(e)).toBe('Transaction failed: Hash Mismatch.')
    })

    it('extracts the error name from the wrapper message when data is missing', () => {
      const e = new Error('reverted with the following reason:\nHashMismatch()')
      expect(getUserFriendlyErrorMessage(e)).toBe('Transaction failed: Hash Mismatch.')
    })
  })

  describe('default ERROR_PATTERNS', () => {
    it('matches "insufficient funds" → friendly gas message', () => {
      expect(getUserFriendlyErrorMessage(new Error('insufficient funds for gas')))
        .toMatch(/insufficient funds for gas/i)
    })

    it('matches "gas required exceeds"', () => {
      expect(getUserFriendlyErrorMessage(new Error('gas required exceeds allowance')))
        .toMatch(/more gas than allowed/i)
    })

    it('matches replacement-tx-underpriced / nonce-too-low', () => {
      expect(getUserFriendlyErrorMessage(new Error('replacement transaction underpriced')))
        .toMatch(/previous transaction is still pending/i)
      expect(getUserFriendlyErrorMessage(new Error('nonce too low')))
        .toMatch(/previous transaction is still pending/i)
    })

    it('matches network errors', () => {
      expect(getUserFriendlyErrorMessage(new Error('could not detect network')))
        .toMatch(/network/i)
      expect(getUserFriendlyErrorMessage(new Error('Wallet disconnected')))
        .toMatch(/disconnected/i)
    })

    it('matches timeout / fetch failure / rate-limit / unavailable', () => {
      expect(getUserFriendlyErrorMessage(new Error('Request timed out (ETIMEDOUT)')))
        .toMatch(/try again/i)
      expect(getUserFriendlyErrorMessage(new Error('fetch failed')))
        .toMatch(/server/i)
      expect(getUserFriendlyErrorMessage(new Error('429 Too Many Requests')))
        .toMatch(/wait a moment/i)
      expect(getUserFriendlyErrorMessage(new Error('503 service unavailable')))
        .toMatch(/temporarily unavailable/i)
    })

    it('matches generic "execution reverted" as the last revert fallback', () => {
      expect(getUserFriendlyErrorMessage(new Error('execution reverted')))
        .toMatch(/transaction failed on-chain/i)
    })
  })

  describe('overrides', () => {
    it('consumer-supplied patterns are checked BEFORE defaults', () => {
      const msg = getUserFriendlyErrorMessage(new Error('insufficient funds for gas'), {
        patterns: [{ pattern: /insufficient funds/i, message: 'Custom: top up your wallet.' }],
      })
      expect(msg).toBe('Custom: top up your wallet.')
    })

    it('custom fallback is used when nothing matches', () => {
      const msg = getUserFriendlyErrorMessage(new Error('totally unknown'), {
        fallback: 'Yikes — try again later.',
      })
      expect(msg).toBe('Yikes — try again later.')
    })
  })

  describe('input normalisation', () => {
    it('handles a thrown string', () => {
      expect(getUserFriendlyErrorMessage('insufficient funds for gas'))
        .toMatch(/insufficient funds/i)
    })

    it('handles a thrown plain object via JSON', () => {
      expect(getUserFriendlyErrorMessage({ message: 'execution reverted', code: -32000 }))
        .toMatch(/transaction failed on-chain/i)
    })

    it('handles an object that fails JSON.stringify (circular)', () => {
      const a: { self?: unknown } = {}
      a.self = a
      // Should not throw — falls back to String(a) = "[object Object]" which
      // matches no pattern, returns the default fallback.
      expect(getUserFriendlyErrorMessage(a)).toMatch(/something went wrong/i)
    })

    it('returns the generic fallback for null / undefined', () => {
      expect(getUserFriendlyErrorMessage(null)).toMatch(/something went wrong/i)
      expect(getUserFriendlyErrorMessage(undefined)).toMatch(/something went wrong/i)
    })
  })

  describe('consumer pattern fall-through', () => {
    it('falls through to default patterns when consumer patterns do not match', () => {
      // Drives the false-arm of the consumer-patterns iteration:
      // a consumer pattern is registered but doesn't match `raw`,
      // so the loop completes without returning and the default
      // patterns take over.
      const msg = getUserFriendlyErrorMessage('insufficient funds for gas', {
        patterns: [{ pattern: /will-not-match/, message: 'unused' }],
      })
      expect(msg).toMatch(/insufficient funds/i)
    })
  })
})

describe('DEFAULT_ERROR_PATTERNS', () => {
  it('is a non-empty list of pattern/message pairs', () => {
    expect(DEFAULT_ERROR_PATTERNS.length).toBeGreaterThan(0)
    for (const entry of DEFAULT_ERROR_PATTERNS) {
      expect(entry.pattern).toBeInstanceOf(RegExp)
      expect(typeof entry.message).toBe('string')
      expect(entry.message.length).toBeGreaterThan(0)
    }
  })
})
