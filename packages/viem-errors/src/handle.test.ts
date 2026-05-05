import { describe, it, expect, vi } from 'vitest'
import { handleWalletError } from './handle.js'
import { USER_REJECTION_MESSAGE } from './rejection.js'

const buildOptions = () => ({
  setStatus: vi.fn(),
  setErrorMessage: vi.fn(),
  toast: { error: vi.fn(), info: vi.fn() },
  onError: vi.fn(),
})

describe('handleWalletError', () => {
  describe('on user rejection', () => {
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 })

    it('resets status to idle, clears the error message, and info-toasts the rejection copy', () => {
      const opts = buildOptions()
      handleWalletError(rejection, opts)

      expect(opts.setStatus).toHaveBeenCalledExactlyOnceWith('idle')
      expect(opts.setErrorMessage).toHaveBeenCalledExactlyOnceWith(null)
      expect(opts.toast.info).toHaveBeenCalledExactlyOnceWith(USER_REJECTION_MESSAGE)
      expect(opts.toast.error).not.toHaveBeenCalled()
    })

    it('still forwards the original error to onError', () => {
      const opts = buildOptions()
      handleWalletError(rejection, opts)
      expect(opts.onError).toHaveBeenCalledExactlyOnceWith(rejection)
    })
  })

  describe('on real error', () => {
    const real = new Error('insufficient funds for gas')

    it('sets status to error and stores a friendly message', () => {
      const opts = buildOptions()
      handleWalletError(real, opts)

      expect(opts.setStatus).toHaveBeenCalledExactlyOnceWith('error')
      expect(opts.setErrorMessage).toHaveBeenCalledOnce()
      const [stored] = opts.setErrorMessage.mock.calls[0]!
      expect(stored).toMatch(/insufficient funds for gas/i)
    })

    it('error-toasts the friendly message; never info-toasts', () => {
      const opts = buildOptions()
      handleWalletError(real, opts)
      expect(opts.toast.error).toHaveBeenCalledOnce()
      expect(opts.toast.info).not.toHaveBeenCalled()
    })

    it('forwards customErrors / fallback to the message resolver', () => {
      const opts = buildOptions()
      handleWalletError(
        { data: { errorName: 'HashMismatch' } },
        { ...opts, customErrors: { HashMismatch: 'Proof did not match.' } },
      )
      expect(opts.toast.error).toHaveBeenCalledExactlyOnceWith('Proof did not match. (HashMismatch)')
    })

    it('coerces a non-Error thrown value into an Error before calling onError', () => {
      const opts = buildOptions()
      handleWalletError('something broke', opts)

      expect(opts.onError).toHaveBeenCalledOnce()
      const [forwarded] = opts.onError.mock.calls[0]!
      expect(forwarded).toBeInstanceOf(Error)
      expect((forwarded as Error).message).toBe('something broke')
    })
  })

  describe('with all optional callbacks omitted', () => {
    it('does not throw — every sink is optional', () => {
      expect(() => handleWalletError(new Error('boom'))).not.toThrow()
      expect(() => handleWalletError(new Error('boom'), {})).not.toThrow()
    })
  })
})
