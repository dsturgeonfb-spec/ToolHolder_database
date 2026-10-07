/**
 * Test harness: a fresh copy of the seeded database in a temp data folder, served on a free port.
 * Every test file gets its own server, so tests can write without affecting each other.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppServer } from '../src/server/app.js'

/** Repo root (tests run from dist/test/...). */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FIXTURES = join(REPO, 'test', 'fixtures')

export interface ApiResult<T = any> {
  status: number
  body: T
  headers: Headers
  text: string
}

export interface TestApp {
  app: AppServer
  base: string
  dataDir: string
  /** Calls the API as the host PC, as `user` (default 'Test User'). */
  api<T = any>(method: string, path: string, body?: unknown, opts?: { user?: string | null; raw?: string; contentType?: string }): Promise<ApiResult<T>>
  close(): Promise<void>
}

export async function startTestApp(): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'hc-test-'))
  const app = new AppServer({ dataDir, appRoot: REPO, log: () => {}, autoBackup: false })
  const port = await app.listen(0)
  const base = `http://127.0.0.1:${port}`
  return {
    app,
    base,
    dataDir,
    async api(method, path, body, opts = {}) {
      const headers: Record<string, string> = { 'X-Requested-With': 'HolderCatalogue' }
      const user = opts.user === undefined ? 'Test User' : opts.user
      if (user) headers['X-User'] = encodeURIComponent(user)
      let payload: string | undefined
      if (opts.raw !== undefined) {
        payload = opts.raw
        headers['Content-Type'] = opts.contentType ?? 'text/plain'
      } else if (body !== undefined) {
        payload = JSON.stringify(body)
        headers['Content-Type'] = 'application/json'
      }
      const res = await fetch(base + path, { method, headers, body: payload })
      const text = await res.text()
      let parsed: any = text
      if ((res.headers.get('content-type') ?? '').includes('application/json')) parsed = text ? JSON.parse(text) : null
      return { status: res.status, body: parsed, headers: res.headers, text }
    },
    async close() {
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
