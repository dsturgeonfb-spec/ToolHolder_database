/**
 * Builds the app server: data folder setup, database migration, routes, static UI.
 *
 * The same server runs inside the Electron window (host PC) and standalone
 * (`node dist/src/server/standalone.js`) — e.g. on a shop PC that serves tablets.
 *
 * Two listeners:
 *  - 127.0.0.1:<port>  the host's own window. Trusted (loopback), may use host-only routes.
 *  - 0.0.0.0:<share>   only while "Share on network" is on. Every request needs a session
 *                      from POST /api/login with the PIN shown on the host.
 * One process owns the SQLite file, so multiple PCs never write it concurrently over a share.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, createReadStream, writeFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, migrate } from './db.js'
import { Jobs } from './jobs.js'
import type { AppContext, AppPaths, Logger, ShareState } from './context.js'
import {
  CONTENT_TYPES,
  Download,
  HttpError,
  Reply,
  Router,
  readBody,
  sendDownload,
  sendJson,
  type Req,
} from './http.js'
import { getSetting, setSetting, requireUser, getSummary, today, nowStamp, logEvent } from './domain.js'
import { backupIfDue } from './modules/system.js'
import { toCsv } from './lib/csv.js'
import { registerModules } from './modules/index.js'

export interface AppOptions {
  dataDir: string
  /** Defaults to the folder containing package.json above this file. */
  appRoot?: string
  /** Defaults to appRoot (db/holder_catalogue.sqlite + images/cam in the repo). */
  seedDir?: string
  version?: string
  log?: Logger
  /** Daily backup check while the server runs (3 s after start, then hourly). Default on; tests turn it off. */
  autoBackup?: boolean
}

export function defaultAppRoot(): string {
  // dist/src/server/app.js -> repo root (or app.asar root when packaged)
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

export function resolvePaths(opts: AppOptions): AppPaths {
  const appRoot = opts.appRoot ?? defaultAppRoot()
  const dataDir = resolve(opts.dataDir)
  return {
    appRoot,
    uiDir: join(appRoot, 'ui'),
    schemaPath: join(appRoot, 'db', 'schema.sql'),
    seedDir: opts.seedDir ?? appRoot,
    dataDir,
    dbPath: join(dataDir, 'holder_catalogue.sqlite'),
    imagesDir: join(dataDir, 'images'),
    backupsDir: join(dataDir, 'backups'),
    logsDir: join(dataDir, 'logs'),
    importsDir: join(dataDir, 'imports'),
  }
}

/**
 * First run: copy the seeded database and the hyperMILL profile images into the data folder.
 * Never overwrites — an existing database is the shop's record.
 */
export function ensureDataFolder(paths: AppPaths, log: Logger): { seeded: boolean } {
  for (const d of [paths.dataDir, paths.imagesDir, join(paths.imagesDir, 'cam'), join(paths.imagesDir, 'vendor'), paths.backupsDir, paths.logsDir, paths.importsDir])
    mkdirSync(d, { recursive: true })
  let seeded = false
  if (!existsSync(paths.dbPath)) {
    const seedDb = join(paths.seedDir, 'db', 'holder_catalogue.sqlite')
    if (!existsSync(seedDb)) throw new Error(`Seed database not found at ${seedDb}`)
    copyFileSync(seedDb, paths.dbPath)
    seeded = true
    log('info', `Seeded new database from ${seedDb}`)
  }
  const seedImages = join(paths.seedDir, 'images', 'cam')
  if (existsSync(seedImages)) {
    for (const f of readdirSync(seedImages)) {
      const dst = join(paths.imagesDir, 'cam', f)
      if (!existsSync(dst)) copyFileSync(join(seedImages, f), dst)
    }
  }
  return { seeded }
}

const consoleLog: Logger = (level, message) => (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${level}] ${message}`)

/** Header every API write must carry: a cross-site page cannot set it without a CORS preflight we never answer. */
export const CSRF_HEADER = 'x-requested-with'
export const CSRF_VALUE = 'HolderCatalogue'
const SESSION_COOKIE = 'hc_session'
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
}

export class AppServer {
  readonly ctx: AppContext
  readonly router = new Router()
  private local: Server | null = null
  private shared: Server | null = null
  private shareState: ShareState = { enabled: false, port: 8763, pin: null, urls: [] }
  private sessions = new Map<string, { name: string; expires: number }>()
  private pinAttempts = new Map<string, { n: number; since: number }>()
  /** Wrong PINs from ANY address in the last hour — a LAN-wide guessing attempt locks sign-in until a new PIN. */
  private pinFailures: number[] = []
  private timers: NodeJS.Timeout[] = []
  private readonly lockFile: string
  private readonly autoBackup: boolean

  constructor(opts: AppOptions) {
    const log = opts.log ?? consoleLog
    const paths = resolvePaths(opts)
    ensureDataFolder(paths, log)
    this.lockFile = join(paths.dataDir, 'holder_catalogue.lock')
    acquireDataLock(this.lockFile, log)
    this.autoBackup = opts.autoBackup ?? true
    let db
    try {
      db = openDatabase(paths.dbPath)
    } catch (err) {
      releaseDataLock(this.lockFile)
      throw err
    }
    migrate(db, readFileSync(paths.schemaPath, 'utf8'))
    const version = opts.version ?? readVersion(paths.appRoot)
    this.ctx = {
      db,
      paths,
      version,
      jobs: new Jobs(),
      log,
      share: { get: () => this.getShare(), set: (o) => this.setShare(o) },
    }
    // Retry keys older than a week are of no further use.
    db.run(`DELETE FROM request_keys WHERE at < ?`, [nowStamp(new Date(Date.now() - 7 * 24 * 3600_000))])
    const saved = getSetting<{ enabled?: boolean; port?: number; pin?: string } | null>(db, 'share', null)
    if (saved) this.shareState = { enabled: false, port: saved.port ?? 8763, pin: saved.pin ?? null, urls: [] }
    this.registerCoreRoutes()
    registerModules(this.router, this.ctx)
  }

  /** Starts the loopback listener (port 0 = any free port) and, if it was on last time, network sharing. */
  async listen(port = 0): Promise<number> {
    this.local = createServer((req, res) => void this.handle(req, res, false))
    await new Promise<void>((ok, fail) => {
      this.local!.once('error', fail)
      this.local!.listen(port, '127.0.0.1', () => ok())
    })
    const saved = getSetting<{ enabled?: boolean } | null>(this.ctx.db, 'share', null)
    if (saved?.enabled) {
      try {
        await this.setShare({ enabled: true })
      } catch (err) {
        this.ctx.log('warn', `Could not resume network sharing: ${err instanceof Error ? err.message : err}`)
      }
    }
    // Keep the data lock fresh so another PC can tell this one is alive.
    this.timers.push(setInterval(() => touchDataLock(this.lockFile), 60_000))
    if (this.autoBackup) {
      const tick = () => {
        try {
          backupIfDue(this.ctx)
        } catch (err) {
          this.ctx.log('error', `Automatic backup failed: ${err instanceof Error ? err.message : err}`)
        }
      }
      this.timers.push(setTimeout(tick, 3000), setInterval(tick, 3600_000))
    }
    for (const t of this.timers) t.unref()
    const addr = this.local.address()
    return typeof addr === 'object' && addr ? addr.port : port
  }

  get port(): number {
    const addr = this.local?.address()
    return typeof addr === 'object' && addr ? addr.port : 0
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.ctx.jobs.cancelAll()
    await Promise.all([closeServer(this.local), closeServer(this.shared)])
    this.local = this.shared = null
    try {
      this.ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* best effort */
    }
    this.ctx.db.close()
    releaseDataLock(this.lockFile)
  }

  getShare(): ShareState {
    return { ...this.shareState, urls: this.shareState.enabled ? lanUrls(this.shareState.port) : [] }
  }

  async setShare(o: { enabled: boolean; port?: number; regeneratePin?: boolean }): Promise<ShareState> {
    const port = o.port ?? this.shareState.port
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new HttpError(400, 'Port must be between 1024 and 65535')
    let pin = this.shareState.pin
    if (!pin || o.regeneratePin) {
      pin = String(randomInt(0, 1_000_000)).padStart(6, '0')
      this.sessions.clear()
      this.pinFailures = []
    }
    await closeServer(this.shared)
    this.shared = null
    this.shareState = { enabled: false, port, pin, urls: [] }
    if (o.enabled) {
      const srv = createServer((req, res) => void this.handle(req, res, true))
      try {
        await new Promise<void>((ok, fail) => {
          srv.once('error', fail)
          srv.listen(port, '0.0.0.0', () => ok())
        })
      } catch (err) {
        const msg = (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${port} is already in use on this PC — pick another.` : String(err)
        this.shareState.error = msg
        setSetting(this.ctx.db, 'share', { enabled: false, port, pin })
        throw new HttpError(409, msg)
      }
      this.shared = srv
      this.shareState.enabled = true
      this.ctx.log('info', `Network sharing on, port ${port}`)
    } else {
      this.ctx.log('info', 'Network sharing off')
    }
    setSetting(this.ctx.db, 'share', { enabled: this.shareState.enabled, port, pin })
    return this.getShare()
  }

  private isOwnHost(header: string | undefined): boolean {
    const h = String(header ?? '').toLowerCase()
    return h === `127.0.0.1:${this.port}` || h === `localhost:${this.port}` || h === `[::1]:${this.port}`
  }

  /** Request handler — exported for tests that want to call it on an ephemeral server. */
  async handle(req: IncomingMessage, res: ServerResponse, viaShare: boolean): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local')
    const path = url.pathname
    const isHost = !viaShare && isLoopback(req.socket.remoteAddress)
    try {
      // DNS rebinding: a web page whose name resolves to 127.0.0.1 would otherwise get the host's rights.
      // The app's own window always asks for 127.0.0.1:<port> (or localhost).
      if (!viaShare && !this.isOwnHost(req.headers.host)) throw new HttpError(421, 'Wrong host name for this server')
      if (path.startsWith('/api/')) {
        await this.handleApi(req, res, url, isHost, viaShare)
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed')
      if (path.startsWith('/images/')) {
        if (!isHost && !this.sessionOf(req)) throw new HttpError(401, 'Sign in first')
        return serveFile(res, this.ctx.paths.imagesDir, path.slice('/images/'.length), req.method === 'HEAD')
      }
      if (path === '/' || path === '/index.html') return serveFile(res, this.ctx.paths.uiDir, 'index.html', req.method === 'HEAD')
      if (path.startsWith('/ui/')) return serveFile(res, this.ctx.paths.uiDir, path.slice('/ui/'.length), req.method === 'HEAD')
      if (path === '/favicon.ico') return serveFile(res, this.ctx.paths.uiDir, 'favicon.png', req.method === 'HEAD')
      throw new HttpError(404, 'Not found')
    } catch (err) {
      this.sendError(res, err, path)
    }
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, url: URL, isHost: boolean, viaShare: boolean): Promise<void> {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD' && req.headers[CSRF_HEADER] !== CSRF_VALUE)
      throw new HttpError(403, 'Missing request header — use the app UI or send X-Requested-With: HolderCatalogue')
    let sessionUser: string | null = null
    if (!isHost) {
      const open = url.pathname === '/api/login' || url.pathname === '/api/session' || url.pathname === '/api/health'
      const s = this.sessionOf(req)
      if (!s && !open) throw new HttpError(401, 'Sign in with the PIN shown on the host PC')
      sessionUser = s?.name ?? null
      if (!viaShare) throw new HttpError(403, 'Not allowed')
    }
    const m = this.router.match(method === 'HEAD' ? 'GET' : method, url.pathname)
    if (!m) throw new HttpError(404, `No API route ${method} ${url.pathname}`)
    if ('allowed' in m) throw new HttpError(405, `Use ${m.allowed.join(' or ')}`)
    if (m.route.opts.hostOnly && !isHost) throw new HttpError(403, 'Only the host PC can do this')
    const headerUser = decodeHeader(req.headers['x-user'])
    const r: Req = {
      method,
      path: url.pathname,
      params: m.params,
      query: url.searchParams,
      body: await readBody(req),
      raw: req,
      // A network client is always recorded under the name it signed in with. Printable pages are opened
      // in a new window (no custom headers), so a host GET may name the person in ?by= — display only, never a write.
      user: isHost ? (headerUser ?? (method === 'GET' ? url.searchParams.get('by')?.trim().slice(0, 80) || null : null)) : sessionUser,
      isHost,
    }
    // Retry-safe writes: the same Idempotency-Key on the same route returns the first answer.
    const key = method !== 'GET' && method !== 'HEAD' ? String(req.headers['idempotency-key'] ?? '').trim() : ''
    if (key) {
      if (key.length > 100) throw new HttpError(400, 'Idempotency-Key is too long')
      const prev = this.ctx.db.get<{ method: string; path: string; status: number; body_json: string | null }>(
        `SELECT method, path, status, body_json FROM request_keys WHERE key = ?`,
        [key],
      )
      if (prev) {
        if (prev.method !== method || prev.path !== url.pathname) throw new HttpError(409, 'That request key was used for a different request')
        return sendJson(res, prev.status, prev.body_json ? JSON.parse(prev.body_json) : null, { 'Idempotent-Replay': 'true' })
      }
    }
    const out = await m.route.handler(r)
    if (key && !(out instanceof Download)) {
      const status = out instanceof Reply ? out.status : out === undefined ? 204 : 200
      if (status < 300)
        this.ctx.db.run(`INSERT OR IGNORE INTO request_keys(key, method, path, status, body_json, at) VALUES (?,?,?,?,?,?)`, [
          key,
          method,
          url.pathname,
          status,
          JSON.stringify(out instanceof Reply ? out.body : (out ?? null)),
          nowStamp(),
        ])
    }
    if (out instanceof Download) return sendDownload(res, out)
    if (out instanceof Reply) return sendJson(res, out.status, out.body, out.headers)
    if (out === undefined) {
      res.writeHead(204, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    sendJson(res, 200, out)
  }

  private sendError(res: ServerResponse, err: unknown, path: string): void {
    if (res.headersSent) {
      res.end()
      return
    }
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message, details: err.details ?? null })
      return
    }
    const msg = err instanceof Error ? err.message : String(err)
    // SQLite constraint failures are the user's input, not a crash.
    if (/constraint failed/i.test(msg)) {
      sendJson(res, 409, { error: friendlyConstraint(msg) })
      return
    }
    this.ctx.log('error', `${path}: ${err instanceof Error ? (err.stack ?? msg) : msg}`)
    sendJson(res, 500, { error: `Something went wrong: ${msg}` })
  }

  private sessionOf(req: IncomingMessage): { name: string } | null {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (!token) return null
    const s = this.sessions.get(token)
    if (!s || s.expires < Date.now()) {
      if (s) this.sessions.delete(token)
      return null
    }
    return s
  }

  private registerCoreRoutes(): void {
    const r = this.router
    const ctx = this.ctx
    r.get('/api/health', () => ({ ok: true, version: ctx.version }))

    r.get('/api/session', (req) => {
      if (req.isHost) return { host: true, signedIn: true, name: req.user }
      const s = this.sessionOf(req.raw)
      return { host: false, signedIn: !!s, name: s?.name ?? null }
    })

    r.post('/api/login', (req) => {
      if (req.isHost) return { host: true, signedIn: true }
      const ip = req.raw.socket.remoteAddress ?? '?'
      const a = this.pinAttempts.get(ip) ?? { n: 0, since: Date.now() }
      if (Date.now() - a.since > 60_000) Object.assign(a, { n: 0, since: Date.now() })
      if (a.n >= 8) throw new HttpError(429, 'Too many wrong PINs — wait a minute and try again')
      this.pinFailures = this.pinFailures.filter((t) => Date.now() - t < 3600_000)
      if (this.pinFailures.length >= GLOBAL_PIN_FAILURES)
        throw new HttpError(429, 'Network sign-in is locked after too many wrong PINs. On the host PC: Settings → Share on network → New PIN.')
      const pin = String(req.body?.pin ?? '')
      const name = requireUser(req.body?.name)
      const want = this.shareState.pin ?? ''
      const ok = pin.length === want.length && want.length > 0 && timingSafeEqual(Buffer.from(pin), Buffer.from(want))
      if (!ok) {
        a.n++
        this.pinAttempts.set(ip, a)
        this.pinFailures.push(Date.now())
        this.ctx.log('warn', `Wrong network PIN from ${ip} (name given: ${name}); ${this.pinFailures.length} in the last hour`)
        if (this.pinFailures.length === GLOBAL_PIN_FAILURES)
          this.ctx.log('warn', 'Network sign-in locked after too many wrong PINs — make a new PIN to unlock it')
        throw new HttpError(401, 'Wrong PIN')
      }
      this.ctx.log('info', `Network sign-in: ${name} from ${ip}`)
      this.pinAttempts.delete(ip)
      const token = randomBytes(24).toString('base64url')
      this.sessions.set(token, { name, expires: Date.now() + SESSION_TTL_MS })
      return new Reply(200, { signedIn: true, name }, {
        'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
      })
    })

    r.post('/api/logout', (req) => {
      const token = parseCookies(req.raw.headers.cookie)[SESSION_COOKIE]
      if (token) this.sessions.delete(token)
      return new Reply(200, { signedIn: false }, { 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
    })

    r.get('/api/system/share', () => this.getShare(), { hostOnly: true })
    r.put(
      '/api/system/share',
      (req) =>
        this.setShare({
          enabled: !!req.body?.enabled,
          port: req.body?.port != null ? Number(req.body.port) : undefined,
          regeneratePin: !!req.body?.regeneratePin,
        }),
      { hostOnly: true },
    )

    r.get('/api/jobs', () => ctx.jobs.list().map(({ log: _log, result: _result, ...s }) => s))
    r.get('/api/jobs/:id', (req) => {
      const j = ctx.jobs.get(req.params.id!)
      if (!j) throw new HttpError(404, 'No such job (jobs are kept in memory until the app closes)')
      return j
    })
    r.post('/api/jobs/:id/cancel', (req) => {
      const j = ctx.jobs.cancel(req.params.id!)
      if (!j) throw new HttpError(404, 'No such job')
      return j
    })

    // Settings that travel with the data (who books counts, inspection interval, vendor contact).
    r.get('/api/settings', () => readSettings(ctx))
    r.put('/api/settings', (req) => {
      const user = requireUser(req.user)
      const b = req.body ?? {}
      // Validate everything first, then write it all in one transaction — a bad field changes nothing.
      const next: Record<string, unknown> = {}
      if (b.users !== undefined) {
        if (!Array.isArray(b.users)) throw new HttpError(400, 'users must be a list of names')
        next.users = [...new Set(b.users.map((u: unknown) => String(u).trim().slice(0, 80)).filter(Boolean))].slice(0, 100)
      }
      if (b.unit_inspection_days !== undefined) {
        const n = Number(b.unit_inspection_days)
        if (!Number.isInteger(n) || n < 1 || n > 3650) throw new HttpError(400, 'Inspection interval must be 1–3650 days')
        next.unit_inspection_days = n
      }
      if (b.vendor_contact !== undefined) next.vendor_contact = String(b.vendor_contact).trim().slice(0, 200)
      if (b.default_interface !== undefined) {
        const code = String(b.default_interface)
        if (!ctx.db.value(`SELECT 1 FROM interfaces WHERE interface_code = ?`, [code])) throw new HttpError(400, `Unknown interface ${code}`)
        next.default_interface = code
      }
      const before = readSettings(ctx) as Record<string, unknown>
      ctx.db.tx(() => {
        for (const [k, v] of Object.entries(next)) {
          if (JSON.stringify(before[k]) === JSON.stringify(v)) continue
          setSetting(ctx.db, k, v)
          logEvent(ctx.db, { entity: 'setting', entity_id: k, action: 'EDIT', detail: { from: before[k] ?? null, to: v }, by_user: user })
        }
      })
      return readSettings(ctx)
    })

    // Reference data the whole UI needs (filters, labels, pickers).
    r.get('/api/meta', () => ({
      version: ctx.version,
      interfaces: ctx.db.all(`SELECT * FROM interfaces ORDER BY interface_code`),
      types: ctx.db.all(`SELECT * FROM holder_types ORDER BY sort_order, type_code`),
      manufacturers: ctx.db.all(
        `SELECT m.*, (SELECT COUNT(*) FROM holders h WHERE h.manufacturer_id = m.manufacturer_id) AS articles FROM manufacturers m ORDER BY m.name`,
      ),
      locations: ctx.db.all(`SELECT * FROM locations ORDER BY location_id`),
      settings: readSettings(ctx),
      dataDir: ctx.paths.dataDir,
    }))

    // The numbers in the header strip on every screen.
    r.get('/api/summary', () => getSummary(ctx.db))

    // Changes outside the stock ledger and the catalogue (locations, want list, serialised units).
    const auditRows = (q: URLSearchParams) => {
      const where: string[] = []
      const params: string[] = []
      for (const k of ['entity', 'entity_id', 'action'] as const) {
        const v = (q.get(k) ?? '').trim()
        if (v) {
          where.push(`${k} = ?`)
          params.push(v)
        }
      }
      const limit = Math.min(5000, Math.max(1, Number(q.get('limit')) || 500))
      type AuditRow = { event_id: number; entity: string; entity_id: string; action: string; by_user: string | null; at: string; detail_json: string | null }
      return ctx.db
        .all<AuditRow>(
          `SELECT * FROM audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY event_id DESC LIMIT ${limit}`,
          params,
        )
        .map(({ detail_json, ...e }) => ({ ...e, detail: detail_json ? JSON.parse(detail_json) : null }))
    }
    r.get('/api/audit', (req) => auditRows(req.query))
    r.get('/api/export/audit.csv', (req) =>
      new Download(
        `audit_events_${today()}.csv`,
        'text/csv; charset=utf-8',
        toCsv(auditRows(req.query), [
          { header: 'event_id', value: (e) => e.event_id },
          { header: 'at', value: (e) => e.at },
          { header: 'entity', value: (e) => e.entity },
          { header: 'entity_id', value: (e) => e.entity_id },
          { header: 'action', value: (e) => e.action },
          { header: 'by_user', value: (e) => e.by_user },
          { header: 'detail', value: (e) => (e.detail ? JSON.stringify(e.detail) : '') },
        ]),
      ),
    )
  }
}

export function readSettings(ctx: AppContext) {
  return {
    users: getSetting<string[]>(ctx.db, 'users', []),
    unit_inspection_days: getSetting<number>(ctx.db, 'unit_inspection_days', 180),
    vendor_contact: getSetting<string>(ctx.db, 'vendor_contact', ''),
    default_interface: getSetting<string>(ctx.db, 'default_interface', 'HSK-A63'),
  }
}

const GLOBAL_PIN_FAILURES = 50
const LOCK_STALE_MS = 3 * 60_000

interface DataLock {
  host: string
  pid: number
  started: string
  heartbeat: string
}

/**
 * One process — on one PC — may open a data folder. SQLite on a shared drive corrupts with two writers,
 * so a second PC (or a second app on this PC) is refused while the first keeps its lock fresh.
 * A lock not refreshed for 3 minutes is left over from a crash and is taken over.
 */
function acquireDataLock(file: string, log: Logger): void {
  if (existsSync(file)) {
    let lock: DataLock | null = null
    try {
      lock = JSON.parse(readFileSync(file, 'utf8')) as DataLock
    } catch {
      lock = null
    }
    const fresh = lock && Date.now() - new Date(lock.heartbeat).getTime() < LOCK_STALE_MS
    const sameHost = lock?.host === hostname()
    const alive = lock && sameHost && (lock.pid === process.pid || pidAlive(lock.pid))
    if (lock && fresh && (!sameHost || alive))
      throw new Error(
        `This catalogue is already open ${sameHost ? 'in another Holder Catalogue on this PC' : `on PC "${lock.host}"`} (since ${lock.started}).\n\n` +
          'Only one PC may open the data folder. To use it from several PCs, keep it on one PC and turn on Settings → Share on network there.',
      )
    if (lock) log('warn', `Taking over a stale lock left by ${lock.host} (pid ${lock.pid}, last seen ${lock.heartbeat})`)
  }
  writeLock(file, new Date().toISOString())
}

function writeLock(file: string, started: string): void {
  const lock: DataLock = { host: hostname(), pid: process.pid, started, heartbeat: new Date().toISOString() }
  writeFileSync(file, JSON.stringify(lock, null, 2), 'utf8')
}

function touchDataLock(file: string): void {
  try {
    const cur = JSON.parse(readFileSync(file, 'utf8')) as DataLock
    if (cur.pid === process.pid && cur.host === hostname()) writeLock(file, cur.started)
  } catch {
    /* the folder may be briefly unreachable; the next tick tries again */
  }
}

function releaseDataLock(file: string): void {
  try {
    const cur = JSON.parse(readFileSync(file, 'utf8')) as DataLock
    if (cur.pid === process.pid && cur.host === hostname()) rmSync(file, { force: true })
  } catch {
    /* nothing to release */
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function friendlyConstraint(msg: string): string {
  if (/UNIQUE constraint failed: holders\.manufacturer_id, holders\.order_no/.test(msg))
    return 'That maker already has a holder with this order no. — open the existing record instead.'
  if (/UNIQUE constraint failed: locations\.name/.test(msg)) return 'A location with that name already exists.'
  if (/FOREIGN KEY constraint failed/.test(msg)) return 'That refers to a record that does not exist (or is still in use).'
  if (/CHECK constraint failed/.test(msg)) return `A value is not allowed here (${msg.replace(/^.*CHECK constraint failed:\s*/, '')}).`
  return msg
}

function readVersion(appRoot: string): string {
  try {
    return JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function decodeHeader(v: string | string[] | undefined): string | null {
  if (!v) return null
  const s = Array.isArray(v) ? v[0]! : v
  try {
    return decodeURIComponent(s).trim() || null
  } catch {
    return s.trim() || null
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

function lanUrls(port: number): string[] {
  const urls: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${port}`)
  }
  return urls
}

function closeServer(s: Server | null): Promise<void> {
  if (!s) return Promise.resolve()
  return new Promise((ok) => {
    s.close(() => ok())
    s.closeAllConnections?.()
  })
}

/** Serves one file from `base`, refusing anything that resolves outside it. */
function serveFile(res: ServerResponse, base: string, rel: string, headOnly: boolean): void {
  let decoded: string
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    throw new HttpError(400, 'Bad path')
  }
  const root = resolve(base)
  const full = resolve(root, decoded)
  if (full !== root && !full.startsWith(root + sep)) throw new HttpError(403, 'Forbidden')
  let st
  try {
    st = statSync(full)
  } catch {
    throw new HttpError(404, 'Not found')
  }
  if (!st.isFile()) throw new HttpError(404, 'Not found')
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(st.size),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  if (headOnly) {
    res.end()
    return
  }
  createReadStream(full).pipe(res)
}
