/**
 * Where a scan's fetcher comes from — and the test-only ways to replace the network.
 *
 * 1. Programmatic (tests, in-process): `setVendorHooks(app.ctx, { fetch, sleep, now, gates })`.
 *    The API and browser tests use this with `fixtureFetch(test/fixtures/vendors)` and an instant sleep.
 * 2. Environment (manual demos, no network): start the server with
 *      HOLDER_CATALOGUE_VENDOR_FIXTURES=<folder with manifest.json>
 *    and every vendor request is answered from that folder (crawl delays are shortened to ≤ 0.25 s because
 *    no maker site is contacted). Never set this on a production PC.
 * Without either, the real network is used, with the polite rules in fetcher.ts.
 */
import type { AppContext } from '../context.js'
import { getSetting } from '../domain.js'
import { HostGates, PoliteFetcher, SHARED_GATES, defaultSleep, userAgent, type FetchFn, type SleepFn } from './fetcher.js'
import { fixtureFetch } from './fixtures.js'

export interface VendorHooks {
  fetch?: FetchFn
  sleep?: SleepFn
  now?: () => number
  gates?: HostGates
  minDelayMs?: number
  backoffMs?: number
  timeoutMs?: number
}

export const FIXTURES_ENV = 'HOLDER_CATALOGUE_VENDOR_FIXTURES'

const HOOKS = new WeakMap<AppContext, VendorHooks>()
let envCache: { dir: string; hooks: VendorHooks } | null = null

/** Replaces the network for one app instance (tests). Pass null to remove. */
export function setVendorHooks(ctx: AppContext, hooks: VendorHooks | null): void {
  if (hooks) HOOKS.set(ctx, hooks)
  else HOOKS.delete(ctx)
}

function envHooks(): VendorHooks | null {
  const dir = process.env[FIXTURES_ENV]
  if (!dir) return null
  if (envCache?.dir !== dir) {
    const fast: SleepFn = (ms, signal) => defaultSleep(Math.min(ms, 250), signal)
    envCache = { dir, hooks: { fetch: fixtureFetch(dir), sleep: fast, gates: new HostGates() } }
  }
  return envCache.hooks
}

export function vendorHooks(ctx: AppContext): VendorHooks {
  return HOOKS.get(ctx) ?? envHooks() ?? {}
}

/** True when vendor requests are answered from fixtures instead of the real sites. */
export function usingFixtures(ctx: AppContext): boolean {
  return HOOKS.has(ctx) || !!process.env[FIXTURES_ENV]
}

export function currentUserAgent(ctx: AppContext): string {
  return userAgent(ctx.version, getSetting<string>(ctx.db, 'vendor_contact', ''))
}

export function makeFetcher(ctx: AppContext, opts: { signal?: AbortSignal; log?: (m: string) => void } = {}): PoliteFetcher {
  const h = vendorHooks(ctx)
  return new PoliteFetcher({
    userAgent: currentUserAgent(ctx),
    fetch: h.fetch,
    sleep: h.sleep,
    now: h.now,
    gates: h.gates ?? SHARED_GATES,
    minDelayMs: h.minDelayMs,
    backoffMs: h.backoffMs,
    timeoutMs: h.timeoutMs,
    signal: opts.signal,
    log: opts.log,
  })
}

export function gatesFor(ctx: AppContext): HostGates {
  return vendorHooks(ctx).gates ?? SHARED_GATES
}
