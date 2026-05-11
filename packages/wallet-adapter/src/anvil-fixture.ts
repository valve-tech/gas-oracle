/**
 * Shared anvil fixture for the wallet-adapter integration tests.
 *
 * Spawns a local anvil instance via child_process, polls its RPC
 * until ready, exposes its URL and deterministic test-account list,
 * and tears down on test exit. The fixture is Node-only — anvil is
 * a native binary launched from outside the test process.
 *
 * Anvil's deterministic 10-account setup is what we lean on: every
 * account has 10_000 ETH and a known private key. We use the first
 * three slots:
 * - account 0: relayer / signer
 * - account 1: recipient
 * - account 2: spare (Safe co-signer, etc.)
 *
 * Each test file pins its own port to avoid races when multiple
 * integration files run in parallel (the integration config uses
 * `singleFork: true` to serialize anyway, but per-file ports are
 * extra defense).
 */
import { spawn, type ChildProcess } from 'node:child_process'

// Re-export account fixtures so Node-side test files only need one
// import. Browser-side files should import from `./anvil-accounts.js`
// directly to avoid pulling in this file's Node-only machinery.
export { ANVIL_ACCOUNTS } from './anvil-accounts.js'

export interface AnvilFixture {
  url: string
  start: () => Promise<void>
  stop: () => Promise<void>
}

/**
 * Build an anvil fixture bound to a port. Tests should call
 * `start()` in beforeAll and `stop()` in afterAll.
 *
 * Polls `eth_chainId` until anvil responds (anvil prints a banner
 * but parsing stdout is racy across versions). Default poll window
 * is 10 seconds — anvil typically starts in under 500ms locally.
 */
export const createAnvilFixture = (port = 8645): AnvilFixture => {
  const url = `http://127.0.0.1:${port}`
  let proc: ChildProcess | null = null

  const waitForReady = async (deadlineMs: number): Promise<void> => {
    const start = Date.now()
    while (Date.now() - start < deadlineMs) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_chainId',
            params: [],
          }),
        })
        if (res.ok) {
          const json = (await res.json()) as { result?: string }
          if (typeof json.result === 'string') return
        }
      } catch {
        // anvil not listening yet — keep polling.
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`anvil did not respond on ${url} within ${deadlineMs}ms`)
  }

  return {
    url,
    start: async () => {
      if (proc !== null) return
      proc = spawn('anvil', ['--port', String(port), '--silent'], {
        stdio: 'ignore',
      })
      proc.on('error', (err) => {
        console.error(`anvil spawn failed: ${err.message}`)
      })
      await waitForReady(10_000)
    },
    stop: async () => {
      if (proc === null) return
      const exited = new Promise<void>((resolve) => {
        proc?.once('exit', () => resolve())
      })
      proc.kill('SIGTERM')
      await Promise.race([
        exited,
        new Promise((r) => setTimeout(r, 2_000)),
      ])
      proc = null
    },
  }
}
