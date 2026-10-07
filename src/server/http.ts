/**
 * A deliberately small HTTP layer: a router with :params, JSON in/out, file downloads and
 * static files. No framework — the app has one user-facing client (its own UI) and a
 * handful of endpoints, and fewer dependencies means less to audit and package.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export interface Req {
  method: string
  path: string
  params: Record<string, string>
  query: URLSearchParams
  /** Parsed JSON body (object/array), raw text for text/* bodies, or undefined. */
  body: any
  raw: IncomingMessage
  /** Name of the person using the app, from the X-User header (URI-encoded). Writes must check it. */
  user: string | null
  /** True when the request comes from the host PC itself (loopback). Host-only routes require it. */
  isHost: boolean
}

/** A file to download (CSV, XLSX, printable HTML…). */
export class Download {
  constructor(
    readonly filename: string,
    readonly contentType: string,
    readonly body: Buffer | string,
    /** inline = show in the window (printable HTML); attachment = save dialog. */
    readonly disposition: 'attachment' | 'inline' = 'attachment',
  ) {}
}

/** Any status/body you want to send explicitly. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {}
}

export type Handler = (req: Req) => unknown | Promise<unknown>
export interface RouteOptions {
  /** Only the host PC may call this (file paths on disk, backups, network sharing). */
  hostOnly?: boolean
}
interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
  opts: RouteOptions
  path: string
}

export class Router {
  private routes: Route[] = []

  add(method: string, path: string, handler: Handler, opts: RouteOptions = {}): void {
    const keys: string[] = []
    const pattern = new RegExp(
      '^' +
        path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, k: string) => {
          keys.push(k)
          return '([^/]+)'
        }) +
        '$',
    )
    if (this.routes.some((r) => r.method === method && r.path === path)) throw new Error(`Duplicate route ${method} ${path}`)
    this.routes.push({ method, pattern, keys, handler, opts, path })
  }
  get(path: string, h: Handler, o?: RouteOptions) {
    this.add('GET', path, h, o)
  }
  post(path: string, h: Handler, o?: RouteOptions) {
    this.add('POST', path, h, o)
  }
  put(path: string, h: Handler, o?: RouteOptions) {
    this.add('PUT', path, h, o)
  }
  patch(path: string, h: Handler, o?: RouteOptions) {
    this.add('PATCH', path, h, o)
  }
  delete(path: string, h: Handler, o?: RouteOptions) {
    this.add('DELETE', path, h, o)
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | { allowed: string[] } | null {
    const allowed: string[] = []
    for (const r of this.routes) {
      const m = r.pattern.exec(path)
      if (!m) continue
      if (r.method !== method) {
        allowed.push(r.method)
        continue
      }
      const params: Record<string, string> = {}
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)))
      return { route: r, params }
    }
    return allowed.length ? { allowed } : null
  }

  list(): Array<{ method: string; path: string; hostOnly: boolean }> {
    return this.routes.map((r) => ({ method: r.method, path: r.path, hostOnly: !!r.opts.hostOnly }))
  }
}

const MAX_BODY = 25 * 1024 * 1024

export async function readBody(req: IncomingMessage): Promise<any> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large')
    chunks.push(c as Buffer)
  }
  if (!size) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  const type = String(req.headers['content-type'] ?? '')
  if (type.includes('application/json')) {
    try {
      return JSON.parse(text)
    } catch {
      throw new HttpError(400, 'Body is not valid JSON')
    }
  }
  return text
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body ?? null)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(json)
}

export function sendDownload(res: ServerResponse, d: Download): void {
  const body = typeof d.body === 'string' ? Buffer.from(d.body, 'utf8') : d.body
  const ascii = d.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
  res.writeHead(200, {
    'Content-Type': d.contentType,
    'Content-Length': String(body.length),
    'Content-Disposition': `${d.disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(d.filename)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

/** Parses an integer route/query/body value or throws 400. */
export function int(v: unknown, name: string): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim())
  if (!Number.isInteger(n)) throw new HttpError(400, `${name} must be a whole number`)
  return n
}
/** Optional number (null when blank). Throws 400 when present but not numeric. */
export function optNum(v: unknown, name: string): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'))
  if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`)
  return n
}
/** Required non-empty string (trimmed). */
export function str(v: unknown, name: string, max = 2000): string {
  const s = String(v ?? '').trim()
  if (!s) throw new HttpError(400, `${name} is required`)
  if (s.length > max) throw new HttpError(400, `${name} is too long`)
  return s
}
/** Optional string: trimmed, or null when blank. */
export function optStr(v: unknown, max = 4000): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (!s) return null
  if (s.length > max) throw new HttpError(400, 'Value is too long')
  return s
}
