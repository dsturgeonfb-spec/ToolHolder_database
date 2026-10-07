/**
 * The only way the app talks to a maker's website. Polite by construction:
 *  - identifies itself honestly: "HolderCatalogue/<version> (+<contact e-mail>)" — never a browser string;
 *  - reads robots.txt first and never requests a disallowed path;
 *  - one request at a time per site, at least Crawl-delay (or 2 s) apart, across every scan and image job;
 *  - retries with back-off only on 5xx / network errors;
 *  - stops at the first 401/403/429 ("blocked — not retried") and remembers the block for an hour,
 *    so the app never hammers or works around a site that said no;
 *  - every wait is cancellable by the job's signal.
 * And safe: a fetcher only contacts the origins it was created for (the adapter's own sites) — the first
 * address and every redirect hop, robots.txt included — and only when the host name resolves to public
 * internet addresses (never this PC, the office network, link-local or other reserved ranges). So a stored
 * link, a file import or a maker page can never make the host PC read an internal page.
 * The network function, DNS lookup, clock and sleep are injectable so tests run against fixtures with no network.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { isAllowed, parseRobots, policyFor, type RobotsPolicy } from './robots.js'

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>
/** Every address a host name resolves to. */
export type LookupFn = (hostname: string) => Promise<string[]>

/** The real resolver: node:dns lookup with all: true (the answer the operating system gives fetch too). */
export const dnsLookupAll: LookupFn = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address)

export const PRODUCT_TOKEN = 'HolderCatalogue'
export const MIN_DELAY_MS = 2000
const BLOCK_REMEMBER_MS = 60 * 60 * 1000
const ROBOTS_TTL_MS = 60 * 60 * 1000
const MAX_REDIRECTS = 5

/** The honest User-Agent: product/version plus a contact address (the vendor_contact setting). */
export function userAgent(version: string, contact: string | null | undefined): string {
  const c = (contact ?? '').trim().replace(/[^\x20-\x7e]/g, '?').replace(/[()]/g, '')
  return `${PRODUCT_TOKEN}/${version || '0.0.0'} (+${c || 'contact not set'})`
}

export class VendorFetchError extends Error {
  constructor(
    message: string,
    readonly kind: 'blocked' | 'robots' | 'http' | 'network' | 'too_large' | 'bad_url' | 'not_allowed' | 'cancelled',
    readonly status?: number,
  ) {
    super(message)
  }
}
/** 401/403/429: the site refused us. The scan of that maker stops; nothing is retried. */
export class BlockedError extends VendorFetchError {
  constructor(message: string, status?: number) {
    super(message, 'blocked', status)
  }
}
export class RobotsDisallowedError extends VendorFetchError {
  constructor(message: string) {
    super(message, 'robots')
  }
}

function ipv4Public(b: number[]): boolean {
  const [a, c, d] = [b[0]!, b[1]!, b[2]!]
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false // "this network", RFC 1918, loopback, multicast/reserved/broadcast
  if (a === 100 && (c & 0xc0) === 64) return false // 100.64.0.0/10 carrier-grade NAT (RFC 6598)
  if (a === 169 && c === 254) return false // link-local
  if (a === 172 && (c & 0xf0) === 16) return false // RFC 1918
  if (a === 192 && c === 168) return false // RFC 1918
  if (a === 192 && c === 0 && (d === 0 || d === 2)) return false // IETF protocol assignments, TEST-NET-1
  if (a === 192 && c === 88 && d === 99) return false // 6to4 relay anycast
  if (a === 198 && (c === 18 || c === 19)) return false // benchmarking
  if (a === 198 && c === 51 && d === 100) return false // TEST-NET-2
  if (a === 203 && c === 0 && d === 113) return false // TEST-NET-3
  return true
}

/** The 16 bytes of an IPv6 address (with "::" and a dotted IPv4 tail expanded); null when it is not one. */
function ipv6Bytes(ip: string): number[] | null {
  let s = ip.replace(/%.*$/, '').toLowerCase()
  let tail: number[] = []
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (v4) {
    tail = v4.slice(1, 5).map(Number)
    s = s.slice(0, v4.index) + '0:0'
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const words = (h: string) => (h ? h.split(':') : [])
  const head = words(halves[0]!)
  const rest = halves.length === 2 ? words(halves[1]!) : []
  const fill = 8 - head.length - rest.length
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null
  const out: number[] = []
  for (const w of [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest]) {
    if (!/^[0-9a-f]{1,4}$/.test(w)) return null
    const n = parseInt(w, 16)
    out.push(n >> 8, n & 0xff)
  }
  if (tail.length) out.splice(12, 4, ...tail)
  return out.length === 16 ? out : null
}

/**
 * True only for a public internet address. Refused: loopback, "this host", private (RFC 1918, RFC 4193
 * unique-local), carrier-grade NAT (RFC 6598), link-local, site-local, multicast, documentation and
 * benchmark ranges and other reserved space. IPv4 carried inside IPv6 (mapped, NAT64, 6to4) is judged by
 * that IPv4 address.
 */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/%.*$/, '')
  const fam = isIP(bare)
  if (fam === 4) return ipv4Public(bare.split('.').map(Number))
  if (fam !== 6) return false
  const b = ipv6Bytes(bare)
  if (!b) return false
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0)
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return ipv4Public(b.slice(12)) // ::ffff:a.b.c.d
  if (zero(0, 12)) return false // ::, ::1 and the old IPv4-compatible form
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return zero(4, 12) && ipv4Public(b.slice(12)) // NAT64 64:ff9b::/96 (64:ff9b:1::/48 is local use)
  if (b[0] === 0x20 && b[1] === 0x02) return ipv4Public(b.slice(2, 6)) // 6to4 2002::/16
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false // documentation 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2]! < 0x02) return false // IETF protocol assignments 2001::/23 (Teredo, benchmarking, ORCHID…)
  return (b[0]! & 0xe0) === 0x20 // global unicast 2000::/3 only (not fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64…)
}

export interface FetchResult {
  /** URL that answered (after redirects). */
  url: string
  status: number
  contentType: string
  headers: Headers
  body: Buffer
}

interface RobotsState {
  policy: RobotsPolicy | null
  fetchedAt: number
  /** 'ok' = parsed, 'none' = the site has no robots.txt (404) */
  status: 'ok' | 'none'
}

interface HostState {
  queue: Promise<void>
  /** When the last request to this host finished (clock ms); null = never. */
  last: number | null
  robots?: RobotsState
  robotsLoading?: Promise<RobotsState>
  blocked?: { until: number; reason: string; status?: number }
}

/**
 * Per-site state shared by every fetcher in the process (the default), so a scan and an image job on
 * the same site still queue behind each other. Tests pass their own instance.
 */
export class HostGates {
  private hosts = new Map<string, HostState>()
  get(origin: string): HostState {
    let s = this.hosts.get(origin)
    if (!s) {
      s = { queue: Promise.resolve(), last: null }
      this.hosts.set(origin, s)
    }
    return s
  }
  /** What we last read from a site's robots.txt (for the maker cards). */
  robotsOf(origin: string): { policy: RobotsPolicy | null; status: 'ok' | 'none'; fetchedAt: number } | null {
    const s = this.hosts.get(origin)?.robots
    return s ? { ...s } : null
  }
  blockOf(origin: string, now = Date.now()): { until: number; reason: string } | null {
    const b = this.hosts.get(origin)?.blocked
    return b && b.until > now ? { until: b.until, reason: b.reason } : null
  }
}
export const SHARED_GATES = new HostGates()

export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new VendorFetchError('Cancelled', 'cancelled'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      clearTimeout(t)
      reject(new VendorFetchError('Cancelled', 'cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export interface FetcherOptions {
  userAgent: string
  /**
   * The only origins (scheme://host[:port]) this fetcher may contact — the adapter's own sites. Checked for
   * the first address and every redirect hop (robots.txt included). Required: there is no "any site".
   */
  allowedOrigins: readonly string[]
  fetch?: FetchFn
  /**
   * Resolves each host name right before the request; every address must be public (isPublicAddress).
   * Default: node:dns. null switches the check off — only for a test network that never touches DNS
   * (the fixture / injected fetch set through hooks.ts); the app's real fetcher always checks.
   */
  lookup?: LookupFn | null
  sleep?: SleepFn
  now?: () => number
  gates?: HostGates
  signal?: AbortSignal
  log?: (message: string) => void
  /** Floor for the gap between requests to one site (default 2 s). */
  minDelayMs?: number
  /** Per request (default 30 s). */
  timeoutMs?: number
  /** Extra attempts after a 5xx / network error (default 2). */
  retries?: number
  /** First back-off wait; doubles each retry (default 5 s). */
  backoffMs?: number
}

export interface GetOptions {
  accept?: string
  /** Refuse bodies larger than this (default 5 MB). */
  maxBytes?: number
  /** Narrows the fetcher's allowed origins for this one request (e.g. the photo site of one maker). */
  origins?: readonly string[]
}

/** Normalises origins ("https://shop.haimer.com/" → "https://shop.haimer.com"); anything else is dropped. */
export function originsOf(list: readonly string[]): string[] {
  const out = new Set<string>()
  for (const o of list) {
    try {
      const u = new URL(o)
      if (u.protocol === 'http:' || u.protocol === 'https:') out.add(u.origin)
    } catch {
      // not an address: never allowed
    }
  }
  return [...out]
}

export class PoliteFetcher {
  readonly userAgent: string
  /** The origins this fetcher may contact. */
  readonly allowedOrigins: readonly string[]
  private readonly fetchFn: FetchFn
  private readonly lookupFn: LookupFn | null
  private readonly sleepFn: SleepFn
  private readonly now: () => number
  readonly gates: HostGates
  private readonly signal?: AbortSignal
  private readonly log: (m: string) => void
  private readonly minDelay: number
  private readonly timeout: number
  private readonly retries: number
  private readonly backoff: number
  /** Requests actually sent (robots.txt included) — for the job summary. */
  requests = 0

  constructor(o: FetcherOptions) {
    this.userAgent = o.userAgent
    this.allowedOrigins = Object.freeze(originsOf(o.allowedOrigins ?? []))
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init))
    this.lookupFn = o.lookup === undefined ? dnsLookupAll : o.lookup
    this.sleepFn = o.sleep ?? defaultSleep
    this.now = o.now ?? Date.now
    this.gates = o.gates ?? SHARED_GATES
    this.signal = o.signal
    this.log = o.log ?? (() => {})
    this.minDelay = o.minDelayMs ?? MIN_DELAY_MS
    this.timeout = o.timeoutMs ?? 30_000
    this.retries = o.retries ?? 2
    this.backoff = o.backoffMs ?? 5000
  }

  /**
   * GET a page or file, obeying robots.txt and the crawl delay, following up to 5 redirects — every hop
   * only to an allowed origin.
   */
  async get(url: string, opts: GetOptions = {}): Promise<FetchResult> {
    const narrow = opts.origins ? originsOf(opts.origins) : null
    const allowed = narrow ? this.allowedOrigins.filter((o) => narrow.includes(o)) : this.allowedOrigins
    let current = this.checkUrl(url, allowed)
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const origin = current.origin
      this.throwIfBlocked(origin)
      const policy = await this.robots(origin)
      const pathQ = current.pathname + current.search
      if (policy && !isAllowed(policy, pathQ))
        throw new RobotsDisallowedError(`${current.host}${pathQ} is disallowed by the site's robots.txt — skipped.`)
      const res = await this.request(current.toString(), opts)
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) throw new VendorFetchError(`${current.host} answered ${res.status} without a target address`, 'http', res.status)
        current = this.checkUrl(new URL(loc, current).toString(), allowed, current.host)
        continue
      }
      return res
    }
    throw new VendorFetchError(`Too many redirects starting at ${url}`, 'http')
  }

  /** Text of a page (charset from the Content-Type, UTF-8 by default). Non-2xx is an error. */
  async getText(url: string, opts: GetOptions = {}): Promise<{ url: string; text: string; contentType: string }> {
    const r = await this.get(url, { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5', ...opts })
    this.assertOk(r)
    return { url: r.url, text: decodeText(r.body, r.contentType), contentType: r.contentType }
  }

  assertOk(r: FetchResult): void {
    if (r.status === 404 || r.status === 410) throw new VendorFetchError(`Page not found (${r.status}) at ${r.url}`, 'http', r.status)
    if (r.status < 200 || r.status >= 300) throw new VendorFetchError(`${new URL(r.url).host} answered HTTP ${r.status} for ${r.url}`, 'http', r.status)
  }

  /** The robots policy for a site, read once per hour. Throws BlockedError if even robots.txt is refused. */
  async robots(origin: string): Promise<RobotsPolicy | null> {
    const st = this.gates.get(origin)
    if (st.robots && this.now() - st.robots.fetchedAt < ROBOTS_TTL_MS) return st.robots.policy
    if (!st.robotsLoading) {
      st.robotsLoading = this.loadRobots(origin).finally(() => {
        st.robotsLoading = undefined
      })
    }
    const r = await st.robotsLoading
    return r.policy
  }

  private async loadRobots(origin: string): Promise<RobotsState> {
    const st = this.gates.get(origin)
    const host = new URL(origin).host
    let target = `${origin}/robots.txt`
    let res: FetchResult | null = null
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        res = await this.request(target, { accept: 'text/plain,*/*;q=0.5', maxBytes: 512 * 1024 })
      } catch (err) {
        if (err instanceof BlockedError)
          throw new BlockedError(`${host} refused robots.txt (HTTP ${err.status}) — the site blocks automated access, so it is not scanned. Blocked — not retried.`, err.status)
        if (err instanceof VendorFetchError && (err.kind === 'cancelled' || err.kind === 'not_allowed')) throw err
        // RFC 9309: a site that cannot serve robots.txt must be treated as disallowing everything.
        throw new VendorFetchError(`Could not read ${host}/robots.txt (${(err as Error).message}) — not scanning a site whose rules can't be read.`, 'network')
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location')!, target)
        if (!this.allowedOrigins.includes(next.origin))
          throw new VendorFetchError(
            `${host}/robots.txt redirects to ${next.origin}, which is not one of the sites this job may contact — not scanning a site whose rules can't be read.`,
            'not_allowed',
          )
        target = next.toString()
        continue
      }
      break
    }
    let state: RobotsState
    if (res && res.status >= 200 && res.status < 300) {
      const policy = policyFor(parseRobots(decodeText(res.body, res.contentType)), PRODUCT_TOKEN)
      state = { policy, fetchedAt: this.now(), status: 'ok' }
      this.log(
        `${host}: robots.txt read — ${policy.crawlDelay != null ? `crawl-delay ${policy.crawlDelay} s` : 'no crawl-delay (2 s minimum)'}` +
          `${policy.rules.some((r) => !r.allow) ? `, ${policy.rules.filter((r) => !r.allow).length} disallowed paths` : ''}`,
      )
    } else if (res && res.status >= 400 && res.status < 500) {
      state = { policy: null, fetchedAt: this.now(), status: 'none' }
      this.log(`${host}: no robots.txt (HTTP ${res.status}) — keeping the 2 s minimum between requests`)
    } else {
      throw new VendorFetchError(`${host}/robots.txt answered HTTP ${res?.status ?? '?'} — not scanning a site whose rules can't be read.`, 'http', res?.status)
    }
    st.robots = state
    return state
  }

  private delayFor(origin: string): number {
    const p = this.gates.get(origin).robots?.policy
    const crawl = p?.crawlDelay != null ? p.crawlDelay * 1000 : 0
    return Math.max(this.minDelay, crawl)
  }

  private throwIfBlocked(origin: string): void {
    const b = this.gates.get(origin).blocked
    if (b && b.until > this.now()) throw new BlockedError(b.reason, b.status)
  }

  /** Scheme, credentials and the origin allow-list; `from` names the site that redirected here. */
  private checkUrl(url: string, allowed: readonly string[], from?: string): URL {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new VendorFetchError(`Not a web address: ${url}`, 'bad_url')
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new VendorFetchError(`Only http/https addresses are fetched (got ${u.protocol})`, 'bad_url')
    if (u.username || u.password) throw new VendorFetchError('Addresses with a user name/password are not fetched', 'bad_url')
    if (!allowed.includes(u.origin)) {
      const sites = allowed.length ? allowed.map((o) => new URL(o).host).join(', ') : 'no site'
      throw new VendorFetchError(
        `${from ? `${from} redirected to ${u.origin}` : `${u.origin} is not a maker site this job may read`} — not fetched. This job only contacts ${sites}.`,
        'not_allowed',
      )
    }
    u.hash = ''
    return u
  }

  /** Refuses a host name that resolves to this PC, the office network or any other non-public address. */
  private async assertPublicHost(hostname: string): Promise<void> {
    if (!this.lookupFn) return
    const host = hostname.replace(/^\[|\]$/g, '')
    let addrs: string[]
    try {
      addrs = isIP(host) ? [host] : await this.lookupFn(host)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      throw new VendorFetchError(`could not look up ${host} (${e.code ?? e.message})`, 'network')
    }
    if (!addrs.length) throw new VendorFetchError(`could not look up ${host} (no address)`, 'network')
    const bad = addrs.find((a) => !isPublicAddress(a))
    if (bad)
      throw new VendorFetchError(
        `${host} points to ${bad}, which is not a public internet address (this PC, the office network or a reserved range) — not contacted.`,
        'not_allowed',
      )
  }

  /** One URL with retries on 5xx / network errors; throws BlockedError on 401/403/429. */
  private async request(url: string, opts: GetOptions): Promise<FetchResult> {
    const origin = new URL(url).origin
    const host = new URL(url).host
    for (let attempt = 0; ; attempt++) {
      let res: FetchResult
      try {
        res = await this.gated(origin, () => this.once(url, opts))
      } catch (err) {
        if (this.signal?.aborted) throw new VendorFetchError('Cancelled', 'cancelled')
        if (err instanceof VendorFetchError && err.kind !== 'network') throw err
        if (attempt < this.retries) {
          const wait = this.backoff * 2 ** attempt
          this.log(`${host}: ${(err as Error).message} — retrying in ${Math.round(wait / 1000)} s`)
          await this.sleepFn(wait, this.signal)
          continue
        }
        throw new VendorFetchError(`${host} could not be reached after ${attempt + 1} tries (${(err as Error).message})`, 'network')
      }
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'))
        const until = this.now() + (res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(retryAfter * 1000, 60_000) : BLOCK_REMEMBER_MS)
        const reason = `${host} answered HTTP ${res.status} (${res.status === 429 ? 'too many requests' : 'access refused'}) — blocked — not retried. The app will not contact ${host} again until ${new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`
        this.gates.get(origin).blocked = { until, reason, status: res.status }
        this.log(reason)
        throw new BlockedError(reason, res.status)
      }
      if (res.status >= 500) {
        if (attempt < this.retries) {
          const wait = this.backoff * 2 ** attempt
          this.log(`${host}: HTTP ${res.status} — retrying in ${Math.round(wait / 1000)} s`)
          await this.sleepFn(wait, this.signal)
          continue
        }
        throw new VendorFetchError(`${host} answered HTTP ${res.status} after ${attempt + 1} tries`, 'http', res.status)
      }
      return res
    }
  }

  /** Runs `fn` when it is this host's turn and the crawl delay since the last request has passed. */
  private gated<T>(origin: string, fn: () => Promise<T>): Promise<T> {
    const st = this.gates.get(origin)
    const run = async (): Promise<T> => {
      if (this.signal?.aborted) throw new VendorFetchError('Cancelled', 'cancelled')
      if (st.last !== null) {
        const wait = st.last + this.delayFor(origin) - this.now()
        if (wait > 0) await this.sleepFn(wait, this.signal)
      }
      try {
        return await fn()
      } finally {
        st.last = this.now()
      }
    }
    const p = st.queue.then(run, run)
    st.queue = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }

  private async once(url: string, opts: GetOptions): Promise<FetchResult> {
    // Looked up right before each request, inside the retry loop: a failed lookup is a network error.
    await this.assertPublicHost(new URL(url).hostname)
    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)]
    if (this.signal) signals.push(this.signal)
    this.requests++
    let res: Response
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.any(signals),
        headers: {
          'User-Agent': this.userAgent,
          Accept: opts.accept ?? '*/*',
          'Accept-Language': 'en-GB,en;q=0.9',
        },
      })
    } catch (err) {
      if (this.signal?.aborted) throw new VendorFetchError('Cancelled', 'cancelled')
      const e = err as Error
      const msg = e.name === 'TimeoutError' ? `no answer within ${Math.max(1, Math.round(this.timeout / 1000))} s` : (e as any).cause?.code ?? e.message
      throw new VendorFetchError(String(msg), 'network')
    }
    const max = opts.maxBytes ?? 5 * 1024 * 1024
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > max) {
      // Not awaited: cancelling a stream can wait on its other readers; we only need to stop reading.
      void res.body?.cancel().catch(() => {})
      throw new VendorFetchError(`${url} is larger than ${Math.round(max / 1048576)} MB — not downloaded`, 'too_large')
    }
    const body = await readCapped(res, max, url)
    return { url, status: res.status, contentType: res.headers.get('content-type') ?? '', headers: res.headers, body }
  }
}

async function readCapped(res: Response, max: number, url: string): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel().catch(() => {})
      throw new VendorFetchError(`${url} is larger than ${Math.round(max / 1048576)} MB — not downloaded`, 'too_large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Decodes a body using the charset in its Content-Type (UTF-8 when absent or unknown). */
export function decodeText(body: Buffer, contentType: string): string {
  const cs = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1]
  try {
    return new TextDecoder(cs || 'utf-8').decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

/** Sitemaps are often served as .xml.gz files: gunzip when the bytes are gzip, whatever the headers say. */
export function maybeGunzip(body: Buffer): Buffer {
  if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) return gunzipSync(body, { maxOutputLength: 64 * 1024 * 1024 })
  return body
}
