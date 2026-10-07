/**
 * "Scan HAIMER for HSK-A63": a background job that discovers products, reads each page through the polite
 * fetcher and diffs it against the catalogue. The job's result is only a list of proposals — it writes
 * nothing; POST /api/vendors/apply writes what the person approves.
 */
import type { AppContext } from '../context.js'
import type { JobState } from '../jobs.js'
import { HttpError } from '../http.js'
import { BlockedError, VendorFetchError } from './fetcher.js'
import { makeFetcher } from './hooks.js'
import { errorProposal, proposalFor } from './diff.js'
import type { Proposal, ProductRef, ScanContext, VendorAdapter } from './types.js'

export const SCAN_KIND = 'vendor-scan'

export interface ScanResult {
  maker: string
  interface_code: string
  proposals: Proposal[]
  counts: Record<'insert' | 'update' | 'same' | 'error', number>
  /** Set when the site refused us (401/403/429): the scan stopped there. */
  blocked: string | null
  cancelled: boolean
  /** Products read / products found. */
  scanned: number
  total: number
  requests: number
  user_agent: string
  started_by: string
  /** Set once the proposals have been applied (POST /api/vendors/apply). */
  applied_run_id?: number
}

export function countActions(ps: Proposal[]) {
  const c = { insert: 0, update: 0, same: 0, error: 0 }
  for (const p of ps) c[p.action]++
  return c
}

export function startScan(
  ctx: AppContext,
  adapter: VendorAdapter,
  o: { iface: string; orderNos: string[]; full: boolean; user: string },
): JobState {
  const running = ctx.jobs.list().find((j) => j.kind === SCAN_KIND && j.status === 'running' && j.title.startsWith(`Scan ${adapter.maker} `))
  if (running) throw new HttpError(409, `A ${adapter.maker} scan is already running — wait for it or cancel it first.`, { job_id: running.id })
  const what = o.orderNos.length ? `${o.orderNos.length} order no${o.orderNos.length === 1 ? '' : 's'}.` : o.full ? 'full range' : 'catalogue holders'
  return ctx.jobs.start(SCAN_KIND, `Scan ${adapter.maker} for ${o.iface} (${what})`, async (job) => {
    // The scan may only contact this maker's own site(s): every page and redirect hop is checked against them.
    const fetcher = makeFetcher(ctx, { origins: adapter.origins ?? [], signal: job.signal, log: (m) => job.log(m) })
    const sc: ScanContext = { db: ctx.db, fetcher, log: (m) => job.log(m), signal: job.signal }
    const result: ScanResult = {
      maker: adapter.maker,
      interface_code: o.iface,
      proposals: [],
      counts: { insert: 0, update: 0, same: 0, error: 0 },
      blocked: null,
      cancelled: false,
      scanned: 0,
      total: 0,
      requests: 0,
      user_agent: fetcher.userAgent,
      started_by: o.user,
    }
    const finish = () => {
      result.counts = countActions(result.proposals)
      result.requests = fetcher.requests
      result.cancelled = job.signal.aborted
      return result
    }
    job.log(`Started by ${o.user}. Identifying as "${fetcher.userAgent}". Only contacting ${fetcher.allowedOrigins.map((x) => new URL(x).host).join(', ') || 'no site'}.`)
    const known: ProductRef[] = ctx.db
      .all<{ holder_id: string; order_no: string; product_url: string | null }>(
        `SELECT h.holder_id, h.order_no, h.product_url FROM holders h JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
         WHERE m.name = ? AND h.interface_code = ? ORDER BY h.order_no`,
        [adapter.maker, o.iface],
      )
      .map((r) => ({ order_no: r.order_no, url: r.product_url, holder_id: r.holder_id, origin: 'catalogue' as const }))

    let refs: ProductRef[]
    try {
      job.progress(0, 0, 'Finding products…')
      refs = await adapter.discover!(sc, o.iface, { known, entered: o.orderNos, full: o.full })
    } catch (err) {
      if (job.signal.aborted) return finish()
      if (err instanceof BlockedError) {
        result.blocked = err.message
        job.log(`Stopped: ${err.message}`)
        return finish()
      }
      throw new Error(`Could not list ${adapter.maker} products: ${(err as Error).message}`)
    }
    result.total = refs.length
    job.log(`${refs.length} product${refs.length === 1 ? '' : 's'} to read.`)
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!
      if (job.signal.aborted) break
      job.progress(i, refs.length, `Reading ${ref.order_no} (${i + 1} of ${refs.length})`)
      if (ref.error) {
        result.proposals.push(errorProposal(adapter.maker, ref.order_no, ref.error, ref.url ?? null))
        continue
      }
      try {
        const rec = await adapter.fetch!(sc, ref, o.iface)
        const p = proposalFor(ctx.db, rec, o.iface)
        result.proposals.push(p)
        job.log(`${ref.order_no}: ${p.action === 'update' ? `update (${Object.keys(p.fields).join(', ')})` : p.action}${p.error ? ` — ${p.error}` : ''}`)
      } catch (err) {
        if (job.signal.aborted || (err instanceof VendorFetchError && err.kind === 'cancelled')) break
        if (err instanceof BlockedError) {
          result.blocked = err.message
          result.proposals.push(errorProposal(adapter.maker, ref.order_no, err.message, ref.url ?? null))
          job.log(`Stopped the ${adapter.maker} scan: ${err.message}`)
          break
        }
        const msg = (err as Error).message
        result.proposals.push(errorProposal(adapter.maker, ref.order_no, msg, ref.url ?? null))
        job.log(`${ref.order_no}: error — ${msg}`)
      }
      result.scanned = i + 1
    }
    const r = finish()
    job.progress(r.scanned, refs.length, r.cancelled ? 'Cancelled' : r.blocked ? 'Stopped: blocked' : 'Done')
    job.log(
      `${r.cancelled ? 'Cancelled' : 'Finished'}: ${r.counts.insert} new, ${r.counts.update} to update, ${r.counts.same} unchanged, ${r.counts.error} errors ` +
        `(${r.requests} requests). Nothing is written until you approve.`,
    )
    return r
  })
}
