/**
 * Offline stand-in for the network: answers requests from saved maker pages.
 *
 * A fixture folder has a manifest.json mapping each URL to an answer:
 *   "https://shop.haimer.com/robots.txt":   { "file": "haimer/robots.txt", "type": "text/plain" }
 *   "https://…/sitemap-en-1.xml.gz":        { "file": "haimer/sitemap-en-1.xml", "gzip": true }
 *   "https://shop.mapal.com/en/p/0000…":    { "status": 301, "redirect": "https://shop.mapal.com/en/…" }
 *   "https://cuttingtools.ceratizit.com/…": { "status": 403, "body": "Forbidden" }
 *   "https://…/photo.jpg":                  { "base64": "/9j/4AAQ…", "type": "image/jpeg" }
 * Any URL not listed answers 404. Used by the tests and, for demos without network access, by the app
 * itself when HOLDER_CATALOGUE_VENDOR_FIXTURES=<folder> is set (see hooks.ts).
 */
import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { FetchFn } from './fetcher.js'

interface FixtureEntry {
  file?: string
  body?: string
  base64?: string
  type?: string
  status?: number
  redirect?: string
  gzip?: boolean
  headers?: Record<string, string>
}

const GUESS: Array<[RegExp, string]> = [
  [/\.html?$/i, 'text/html; charset=utf-8'],
  [/\.xml$/i, 'application/xml; charset=utf-8'],
  [/\.txt$/i, 'text/plain; charset=utf-8'],
  [/\.jpe?g$/i, 'image/jpeg'],
  [/\.png$/i, 'image/png'],
  [/\.gif$/i, 'image/gif'],
  [/\.webp$/i, 'image/webp'],
]

export interface FixtureFetch extends FetchFn {
  /** Every URL requested, in order (tests assert on politeness with it). */
  requested: Array<{ url: string; userAgent: string | null }>
}

export function fixtureFetch(dir: string): FixtureFetch {
  const root = resolve(dir)
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<string, FixtureEntry>
  const requested: FixtureFetch['requested'] = []
  const fn = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init?.headers)
    requested.push({ url, userAgent: headers.get('user-agent') })
    const e = manifest[url]
    if (!e) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    if (e.redirect) return new Response(null, { status: e.status ?? 301, headers: { location: e.redirect, ...(e.headers ?? {}) } })
    let body: Buffer
    if (e.file) {
      const full = resolve(root, e.file)
      if (!full.startsWith(root + sep)) throw new Error(`Fixture file outside the fixture folder: ${e.file}`)
      body = readFileSync(full)
    } else if (e.base64) body = Buffer.from(e.base64, 'base64')
    else body = Buffer.from(e.body ?? '', 'utf8')
    if (e.gzip) body = gzipSync(body)
    const type = e.type ?? (e.gzip ? 'application/x-gzip' : (GUESS.find(([re]) => re.test(e.file ?? url))?.[1] ?? 'application/octet-stream'))
    return new Response(new Uint8Array(body), { status: e.status ?? 200, headers: { 'content-type': type, ...(e.headers ?? {}) } })
  }) as FixtureFetch
  fn.requested = requested
  return fn
}
