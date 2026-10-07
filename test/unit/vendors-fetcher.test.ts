import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { FIXTURES } from '../helpers.js'
import { FIXTURES_ENV, makeFetcher, setVendorHooks, usingFixtures } from '../../src/server/vendors/hooks.js'
import {
  BlockedError,
  HostGates,
  PoliteFetcher,
  RobotsDisallowedError,
  VendorFetchError,
  maybeGunzip,
  userAgent,
  type FetchFn,
} from '../../src/server/vendors/fetcher.js'

/** Virtual clock: sleep() advances time instead of waiting, and records every wait. */
function fakeClock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleeps,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new VendorFetchError('Cancelled', 'cancelled')
      sleeps.push(ms)
      t += ms
    },
  }
}

type Route = Response | ((n: number) => Response | Promise<Response>)
/** A fake network: url → answer (or a function of the call count). Records each request with its time and UA. */
function fakeNet(routes: Record<string, Route>, clock?: { now: () => number }) {
  const calls: Array<{ url: string; at: number; ua: string | null }> = []
  const counts = new Map<string, number>()
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, at: clock?.now() ?? 0, ua: new Headers(init.headers).get('user-agent') })
    const n = (counts.get(url) ?? 0) + 1
    counts.set(url, n)
    const r = routes[url]
    if (!r) return new Response('nope', { status: 404 })
    return typeof r === 'function' ? r(n) : r.clone()
  }
  return { fn, calls }
}
const html = (s: string, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
const robots = (s: string) => new Response(s, { headers: { 'content-type': 'text/plain' } })

function make(net: ReturnType<typeof fakeNet>, clock: ReturnType<typeof fakeClock>, extra: Partial<ConstructorParameters<typeof PoliteFetcher>[0]> = {}) {
  return new PoliteFetcher({ userAgent: userAgent('1.2.3', 'eng@example.com'), fetch: net.fn, sleep: clock.sleep, now: clock.now, gates: new HostGates(), ...extra })
}

test('honest user agent: product/version + contact, never a browser string', () => {
  assert.equal(userAgent('0.1.0', 'eng@shop.co.uk'), 'HolderCatalogue/0.1.0 (+eng@shop.co.uk)')
  assert.equal(userAgent('0.1.0', ''), 'HolderCatalogue/0.1.0 (+contact not set)')
  assert.equal(userAgent('0.1.0', 'Zoë (eng)'), 'HolderCatalogue/0.1.0 (+Zo? eng)')
  assert.doesNotMatch(userAgent('0.1.0', null), /Mozilla|Chrome|Safari/)
})

test('reads robots.txt first, then waits the 10 s Crawl-delay between every request to the site', async () => {
  const clock = fakeClock()
  const net = fakeNet(
    {
      'https://shop.example.com/robots.txt': robots('User-agent: *\nCrawl-delay: 10\nDisallow: /search\n'),
      'https://shop.example.com/p/1': html('<h1>1</h1>'),
      'https://shop.example.com/p/2': html('<h1>2</h1>'),
      'https://shop.example.com/p/3': html('<h1>3</h1>'),
    },
    clock,
  )
  const f = make(net, clock)
  for (const n of [1, 2, 3]) assert.match((await f.getText(`https://shop.example.com/p/${n}`)).text, new RegExp(`<h1>${n}`))
  assert.deepEqual(net.calls.map((c) => c.url.replace('https://shop.example.com', '')), ['/robots.txt', '/p/1', '/p/2', '/p/3'])
  assert.deepEqual(clock.sleeps, [10_000, 10_000, 10_000])
  assert.deepEqual(net.calls.map((c) => c.at), [0, 10_000, 20_000, 30_000])
  assert.ok(net.calls.every((c) => c.ua === 'HolderCatalogue/1.2.3 (+eng@example.com)'))
  assert.equal(f.requests, 4)
})

test('no Crawl-delay (or no robots.txt) → the 2 s minimum still applies', async () => {
  const clock = fakeClock()
  const net = fakeNet({ 'https://k.example.com/a': html('a'), 'https://k.example.com/b': html('b') }, clock)
  const f = make(net, clock)
  await f.getText('https://k.example.com/a')
  await f.getText('https://k.example.com/b')
  assert.equal(net.calls[0]!.url, 'https://k.example.com/robots.txt', 'robots.txt is still asked for first')
  assert.deepEqual(clock.sleeps, [2000, 2000])
})

test('a path disallowed by robots.txt is never requested', async () => {
  const clock = fakeClock()
  const net = fakeNet({ 'https://shop.example.com/robots.txt': robots('User-agent: *\nDisallow: /search\nDisallow: /*/printpage/\n') }, clock)
  const f = make(net, clock)
  await assert.rejects(f.getText('https://shop.example.com/search?search=A63'), RobotsDisallowedError)
  await assert.rejects(f.getText('https://shop.example.com/en/printpage/abc'), RobotsDisallowedError)
  assert.deepEqual(net.calls.map((c) => c.url), ['https://shop.example.com/robots.txt'])
})

test('403 stops at once: "blocked — not retried", and the site is not contacted again', async () => {
  const clock = fakeClock()
  const net = fakeNet({ 'https://x.example.com/robots.txt': robots('User-agent: *\nAllow: /\n'), 'https://x.example.com/p/1': html('no', 403) }, clock)
  const f = make(net, clock)
  await assert.rejects(f.getText('https://x.example.com/p/1'), (e: unknown) => e instanceof BlockedError && /blocked — not retried/.test(e.message) && e.status === 403)
  await assert.rejects(f.getText('https://x.example.com/p/2'), BlockedError)
  assert.deepEqual(net.calls.map((c) => c.url), ['https://x.example.com/robots.txt', 'https://x.example.com/p/1'])
  assert.ok(f.gates.blockOf('https://x.example.com', clock.now()), 'block remembered for the maker card')
})

test('429 (too many requests) and 401 are blocks too; 429 honours Retry-After', async () => {
  const clock = fakeClock()
  const net = fakeNet({
    'https://y.example.com/a': new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
    'https://z.example.com/a': html('login', 401),
  }, clock)
  const f = make(net, clock)
  await assert.rejects(f.getText('https://y.example.com/a'), (e: unknown) => e instanceof BlockedError && /too many requests/.test(e.message))
  assert.equal(f.gates.blockOf('https://y.example.com', clock.now())!.until, clock.now() + 120_000)
  await assert.rejects(f.getText('https://z.example.com/a'), (e: unknown) => e instanceof BlockedError && e.status === 401)
  assert.equal(net.calls.filter((c) => c.url.endsWith('/a')).length, 2, 'each tried once')
})

test('a site that refuses robots.txt (Ceratizit-style 403) is not scanned at all', async () => {
  const clock = fakeClock()
  const net = fakeNet({ 'https://cuttingtools.example.com/robots.txt': html('Access Denied', 403) }, clock)
  const f = make(net, clock)
  await assert.rejects(f.getText('https://cuttingtools.example.com/gb/en.html'), (e: unknown) => e instanceof BlockedError && /refused robots\.txt/.test(e.message))
  assert.equal(net.calls.length, 1)
})

test('5xx is retried with back-off; a later 200 is used', async () => {
  const clock = fakeClock()
  const net = fakeNet({ 'https://r.example.com/p': (n) => (n < 3 ? html('busy', 503) : html('ok')) }, clock)
  const f = make(net, clock)
  assert.equal((await f.getText('https://r.example.com/p')).text, 'ok')
  // robots (404) → p (503) → wait back-off 5 s → (crawl gap already passed) → p (503) → 10 s → p (200)
  assert.deepEqual(clock.sleeps, [2000, 5000, 10_000])
  assert.equal(net.calls.filter((c) => c.url.endsWith('/p')).length, 3)
})

test('5xx every time → gives up after 3 tries with a clear message; network errors are retried too', async () => {
  const clock = fakeClock()
  const net = fakeNet({ 'https://r.example.com/p': html('down', 500) }, clock)
  const f = make(net, clock)
  await assert.rejects(f.getText('https://r.example.com/p'), /answered HTTP 500 after 3 tries/)
  let n = 0
  const flaky: FetchFn = async (url) => {
    if (url.endsWith('robots.txt')) return new Response('', { status: 404 })
    if (++n < 2) throw new TypeError('fetch failed')
    return html('back')
  }
  const g = new PoliteFetcher({ userAgent: 'HolderCatalogue/t', fetch: flaky, sleep: clock.sleep, now: clock.now, gates: new HostGates() })
  assert.equal((await g.getText('https://flaky.example.com/x')).text, 'back')
})

test('404 is an error for that page only (not retried, no block)', async () => {
  const clock = fakeClock()
  const net = fakeNet({}, clock)
  const f = make(net, clock)
  await assert.rejects(f.getText('https://n.example.com/gone'), (e: unknown) => e instanceof VendorFetchError && e.kind === 'http' && /Page not found \(404\)/.test(e.message))
  assert.equal(f.gates.blockOf('https://n.example.com'), null)
})

test('redirects are followed (up to 5) and robots.txt is checked for the target too', async () => {
  const clock = fakeClock()
  const net = fakeNet({
    'https://shop.example.com/robots.txt': robots('User-agent: *\nDisallow: /private\n'),
    'https://shop.example.com/p/1': new Response(null, { status: 301, headers: { location: '/en/Thing/p/1' } }),
    'https://shop.example.com/en/Thing/p/1': html('thing'),
    'https://shop.example.com/p/2': new Response(null, { status: 302, headers: { location: '/private/2' } }),
  }, clock)
  const f = make(net, clock)
  const r = await f.getText('https://shop.example.com/p/1')
  assert.equal(r.url, 'https://shop.example.com/en/Thing/p/1')
  await assert.rejects(f.getText('https://shop.example.com/p/2'), RobotsDisallowedError)
  assert.ok(!net.calls.some((c) => c.url.includes('/private')))
})

test('bodies over the size limit are refused; non-http(s) addresses are never fetched', async () => {
  const clock = fakeClock()
  const big = new Uint8Array(2048)
  const net = fakeNet({ 'https://b.example.com/big.jpg': new Response(big, { headers: { 'content-type': 'image/jpeg' } }) }, clock)
  const f = make(net, clock)
  await assert.rejects(f.get('https://b.example.com/big.jpg', { maxBytes: 1024 }), (e: unknown) => e instanceof VendorFetchError && e.kind === 'too_large')
  await assert.rejects(f.get('file:///etc/passwd'), (e: unknown) => e instanceof VendorFetchError && e.kind === 'bad_url')
  await assert.rejects(f.get('ftp://b.example.com/x'), (e: unknown) => e instanceof VendorFetchError && e.kind === 'bad_url')
})

test('one request at a time per site, even from two callers at once', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const slow: FetchFn = async (url) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight--
    return url.endsWith('robots.txt') ? new Response('', { status: 404 }) : html('x')
  }
  const gates = new HostGates()
  const opts = { userAgent: 'HolderCatalogue/t', fetch: slow, sleep: async () => {}, gates }
  const a = new PoliteFetcher(opts)
  const b = new PoliteFetcher(opts)
  await Promise.all([a.getText('https://same.example.com/1'), b.getText('https://same.example.com/2'), a.getText('https://same.example.com/3')])
  assert.equal(maxInFlight, 1)
})

test('cancelling the job stops a crawl-delay wait', async () => {
  const ctrl = new AbortController()
  const net = fakeNet({ 'https://c.example.com/robots.txt': robots('User-agent: *\nCrawl-delay: 60\n'), 'https://c.example.com/a': html('a') })
  const f = new PoliteFetcher({ userAgent: 'HolderCatalogue/t', fetch: net.fn, gates: new HostGates(), signal: ctrl.signal })
  await f.getText('https://c.example.com/a') // robots + a (first request to the site does not wait)
  const t0 = Date.now()
  const p = f.getText('https://c.example.com/b')
  setTimeout(() => ctrl.abort(), 20)
  await assert.rejects(p, (e: unknown) => e instanceof VendorFetchError && e.kind === 'cancelled')
  assert.ok(Date.now() - t0 < 5000, 'did not sit out the 60 s delay')
})

test('gzipped sitemaps are unpacked whatever the headers say; plain bytes pass through', () => {
  const xml = '<urlset><url><loc>https://a/b</loc></url></urlset>'
  assert.equal(maybeGunzip(gzipSync(Buffer.from(xml))).toString(), xml)
  assert.equal(maybeGunzip(Buffer.from(xml)).toString(), xml)
})

test('a site that never answers times out (and is retried like any network error)', async () => {
  const hang: FetchFn = (_url, init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))
  const f = new PoliteFetcher({ userAgent: 'HolderCatalogue/t', fetch: hang, sleep: async () => {}, gates: new HostGates(), timeoutMs: 30, retries: 1 })
  // AbortSignal.timeout() does not keep Node alive on its own (the app's HTTP server does); hold the loop open here.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    await assert.rejects(f.getText('https://slow.example.com/x'), (e: unknown) => e instanceof VendorFetchError && /could not be reached after 2 tries \(no answer within 1 s\)/.test(e.message))
  } finally {
    clearInterval(keepAlive)
  }
})

test('test-only hooks: per-app fake network, or HOLDER_CATALOGUE_VENDOR_FIXTURES=<folder> for the whole process', async () => {
  const fakeCtx = { version: '9.9.9', db: { value: () => JSON.stringify('qa@example.com') } } as any
  assert.equal(usingFixtures(fakeCtx), false)
  const prev = process.env[FIXTURES_ENV]
  process.env[FIXTURES_ENV] = join(FIXTURES, 'vendors')
  try {
    assert.equal(usingFixtures(fakeCtx), true)
    const f = makeFetcher(fakeCtx)
    assert.equal(f.userAgent, 'HolderCatalogue/9.9.9 (+qa@example.com)')
    assert.match((await f.getText('https://shop.haimer.com/robots.txt')).text, /Crawl-delay: 10/)
  } finally {
    if (prev === undefined) delete process.env[FIXTURES_ENV]
    else process.env[FIXTURES_ENV] = prev
  }
  const calls: string[] = []
  setVendorHooks(fakeCtx, { fetch: async (url) => (calls.push(url), new Response('', { status: 404 })), sleep: async () => {}, gates: new HostGates() })
  await assert.rejects(makeFetcher(fakeCtx).getText('https://shop.example.com/a'), /Page not found/)
  assert.deepEqual(calls, ['https://shop.example.com/robots.txt', 'https://shop.example.com/a'])
  setVendorHooks(fakeCtx, null)
  assert.equal(usingFixtures(fakeCtx), false)
})
