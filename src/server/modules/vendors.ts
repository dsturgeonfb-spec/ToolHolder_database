/**
 * Vendors module: maker adapters, scan-on-command with diff/approve, file import (CSV / ISO 13399 codes),
 * the maker photo cache and the sources overview. Routes: docs/API.md "Vendors". The work lives in
 * ../vendors/*; this file maps routes to it and validates input.
 *
 * Scans and image downloads are background jobs that never write catalogue or stock data: a scan's
 * result is a list of proposals, and only POST /api/vendors/apply (a person, approving rows/fields)
 * writes — with provenance, holder_changes and an import_runs row. Stock is never touched.
 */
import { randomBytes } from 'node:crypto'
import type { Router } from '../http.js'
import { HttpError, optStr } from '../http.js'
import type { AppContext } from '../context.js'
import { DATA_STATUSES, getSetting, requireUser, type DataStatus } from '../domain.js'
import { adapterFor, ADAPTERS, vendorOverview } from '../vendors/registry.js'
import { startScan, SCAN_KIND, countActions, type ScanResult } from '../vendors/scan.js'
import { applyProposals, errorProposal, parseApprove, proposalFor, type ApplyMeta } from '../vendors/diff.js'
import { parseFileImport } from '../vendors/iso13399.js'
import { startImageJob } from '../vendors/images.js'
import { cleanText, isValidOrderNo, normOrderNo } from '../vendors/parse.js'
import type { Proposal } from '../vendors/types.js'

const MAX_ORDER_NOS = 1000
const MAX_FILE_ROWS = 5000
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000

interface FileImport {
  proposals: Proposal[]
  maker: string
  iface: string
  file: string
  source: string
  created: number
}
interface ModuleState {
  applied: Map<string, number> // job id / token → import_runs.run_id
  files: Map<string, FileImport>
}
const STATE = new WeakMap<AppContext, ModuleState>()
function stateOf(ctx: AppContext): ModuleState {
  let s = STATE.get(ctx)
  if (!s) STATE.set(ctx, (s = { applied: new Map(), files: new Map() }))
  return s
}

function interfaceOf(ctx: AppContext, v: unknown): string {
  const code = optStr(v, 40) ?? getSetting<string>(ctx.db, 'default_interface', 'HSK-A63')
  const hit = ctx.db.value<string>(`SELECT interface_code FROM interfaces WHERE interface_code = ? COLLATE NOCASE`, [code])
  if (!hit) throw new HttpError(400, `Unknown interface "${code}". Pick one of the interfaces in the catalogue (Settings → taper form).`)
  return hit
}

/** Order nos from a list or from text (one per line, or separated by commas/semicolons/tabs). */
function orderNosOf(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return []
  const raw = Array.isArray(v) ? v.map((x) => String(x ?? '')) : typeof v === 'string' ? v.split(/[\r\n,;\t]+/) : null
  if (!raw) throw new HttpError(400, 'order_nos must be a list of order numbers.')
  const out: string[] = []
  const bad: string[] = []
  for (const r of raw) {
    const o = normOrderNo(r)
    if (!o) continue
    if (!isValidOrderNo(o)) bad.push(o)
    else if (!out.some((x) => x.toUpperCase() === o.toUpperCase())) out.push(o)
  }
  if (bad.length) throw new HttpError(400, `These don't look like order numbers: ${bad.slice(0, 5).map((b) => `"${b.slice(0, 30)}"`).join(', ')}. Use the maker's order no., e.g. A63.182.03.8 or 30524702.`)
  if (out.length > MAX_ORDER_NOS) throw new HttpError(400, `At most ${MAX_ORDER_NOS} order numbers per scan.`)
  return out
}

export function register(r: Router, ctx: AppContext): void {
  r.get('/api/vendors', () => vendorOverview(ctx))

  r.post('/api/vendors/:maker/scan', (req) => {
    const user = requireUser(req.user)
    const maker = String(req.params.maker ?? '')
    const adapter = adapterFor(maker)
    if (!adapter) throw new HttpError(404, `No vendor adapter for "${maker}". Makers: ${ADAPTERS.map((a) => a.maker).join(', ')}.`)
    if (!adapter.automated || !adapter.discover || !adapter.fetch)
      throw new HttpError(
        400,
        `${adapter.maker} is not scanned automatically: ${adapter.robots} Use File import with data from the maker or your rep instead.`,
      )
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const iface = interfaceOf(ctx, b.interface_code)
    const orderNos = orderNosOf(b.order_nos)
    const job = startScan(ctx, adapter, { iface, orderNos, full: b.discover === true || b.discover === 'true', user })
    return { job_id: job.id, job }
  })

  r.post('/api/vendors/apply', (req) => {
    const user = requireUser(req.user)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const st = stateOf(ctx)
    const jobId = optStr(b.job_id, 100)
    const token = optStr(b.token, 100)
    if (!jobId === !token) throw new HttpError(400, 'Send either job_id (a vendor scan) or token (a file import), not both.')
    const approve = parseApprove(b.approve)
    const key = (jobId ?? token)!
    const prevRun = st.applied.get(key)
    if (prevRun) throw new HttpError(409, `These proposals were already applied (import run ${prevRun}). Run a new scan or read the file again to pick up later changes.`)

    let proposals: Proposal[]
    let meta: ApplyMeta
    if (jobId) {
      const job = ctx.jobs.get(jobId)
      if (!job || job.kind !== SCAN_KIND) throw new HttpError(404, 'That scan is no longer available (scans are kept in memory until the app closes) — run it again.')
      // A cancelled scan reports "cancelled" a moment before it has handed back what it read.
      if (job.status === 'running' || !job.finished_at) throw new HttpError(409, 'The scan is still running — wait for it to finish (or cancel it) before approving.')
      const result = job.result as ScanResult | undefined
      if (!result) throw new HttpError(409, `The scan ${job.status === 'failed' ? `failed (${job.error})` : 'was cancelled before it read anything'} — there is nothing to approve.`)
      proposals = result.proposals
      meta = {
        kind: 'VENDOR',
        changeSource: `vendor sync ${result.maker}`,
        runSource: result.maker,
        interface_code: result.interface_code,
        reference: (p) => p.source_url,
        ref_id: jobId,
      }
    } else {
      const f = st.files.get(token!)
      if (!f || Date.now() - f.created > TOKEN_TTL_MS) throw new HttpError(404, 'That file import has expired (2 hours) or was already applied — read the file again.')
      proposals = f.proposals
      meta = {
        kind: 'FILE',
        changeSource: `file import ${f.file}`,
        runSource: `${f.file} — ${f.source}`.slice(0, 500),
        interface_code: f.iface,
        reference: () => `${f.file}: ${f.source}`.slice(0, 1000),
        ref_id: token!,
      }
    }
    const res = applyProposals(ctx, user, proposals, approve, meta)
    st.applied.set(key, res.run_id)
    // A reopened scan then shows as approved instead of offering the button again.
    if (jobId) (ctx.jobs.get(jobId)!.result as ScanResult).applied_run_id = res.run_id
    if (token) st.files.delete(token)
    return res
  })

  r.post('/api/vendors/import-file', (req) => {
    const user = requireUser(req.user)
    const q = req.query
    const makerName = optStr(q.get('maker'), 80)
    if (!makerName) throw new HttpError(400, 'Choose the maker the file is for.')
    const mk = ctx.db.get<{ name: string; is_distributor: number }>(`SELECT name, is_distributor FROM manufacturers WHERE name = ? COLLATE NOCASE`, [makerName])
    if (!mk) throw new HttpError(400, `Unknown maker "${makerName}". Pick one of the makers in the catalogue.`)
    const iface = interfaceOf(ctx, q.get('interface_code'))
    const source = cleanText(q.get('source'), 400)
    if (!source) throw new HttpError(400, "Say where this file came from (e.g. 'ISO 13399 package from the Ceratizit rep, 05/10/2026') — it is recorded on every holder it changes.")
    const file = cleanText(q.get('file'), 120)?.replace(/[\\/]/g, '_') ?? 'CSV file'
    const statusRaw = optStr(q.get('data_status'), 40)
    if (statusRaw && !(DATA_STATUSES as readonly string[]).includes(statusRaw)) throw new HttpError(400, `data_status must be one of ${DATA_STATUSES.join(', ')}.`)
    const dataStatus = (statusRaw ?? (mk.is_distributor ? 'distributor_only' : 'catalogue_pdf')) as DataStatus
    const text = typeof req.body === 'string' ? req.body : req.body && typeof req.body.csv === 'string' ? req.body.csv : null
    if (!text || !text.trim()) throw new HttpError(400, 'The file is empty. Choose a CSV file with a header row and one row per holder.')

    const knownMakers = ctx.db.all<{ name: string }>(`SELECT name FROM manufacturers`).map((m) => m.name)
    const parsed = parseFileImport(text, { maker: mk.name, iface, source, dataStatus, isDistributor: !!mk.is_distributor, knownMakers })
    if (!parsed.rows.length) throw new HttpError(400, 'No rows found. The first line must be the column names (order_no or Article, and the values: DCONWS, LPR… or our column names).')
    if (parsed.rows.length > MAX_FILE_ROWS) throw new HttpError(400, `The file has ${parsed.rows.length} rows — split it into files of at most ${MAX_FILE_ROWS}.`)
    const seen = new Map<string, number>()
    const proposals: Proposal[] = parsed.rows.map((row) => {
      const maker = row.record?.manufacturer ?? mk.name
      if (row.error || !row.record) return errorProposal(maker, row.order_no || `line ${row.line}`, row.error ?? 'Unreadable row')
      // Rows are approved by order no., so an order no. may appear once per file (one maker per file for overlaps).
      const k = row.order_no.toUpperCase()
      if (seen.has(k)) return errorProposal(maker, `${row.order_no} (line ${row.line})`, `Line ${row.line}: ${row.order_no} appears twice in the file (first on line ${seen.get(k)}) — only the first is used.`)
      seen.set(k, row.line)
      return proposalFor(ctx.db, row.record, iface)
    })
    const st = stateOf(ctx)
    for (const [t, f] of st.files) if (Date.now() - f.created > TOKEN_TTL_MS) st.files.delete(t)
    while (st.files.size >= 20) st.files.delete(st.files.keys().next().value!)
    const token = randomBytes(12).toString('base64url')
    st.files.set(token, { proposals, maker: mk.name, iface, file, source, created: Date.now() })
    return {
      token,
      maker: mk.name,
      interface_code: iface,
      file,
      source,
      data_status: dataStatus,
      read_by: user,
      proposals,
      counts: countActions(proposals),
      unused_columns: parsed.unused_columns,
      columns: parsed.columns,
    }
  })

  r.post('/api/vendors/images', (req) => {
    const user = requireUser(req.user)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    let ids: string[] | null = null
    if (b.holder_ids !== undefined && b.holder_ids !== null) {
      if (!Array.isArray(b.holder_ids) || b.holder_ids.some((x: unknown) => typeof x !== 'string' || !x.trim()))
        throw new HttpError(400, 'holder_ids must be a list of holder ids (e.g. ["H0001"]).')
      ids = [...new Set((b.holder_ids as string[]).map((x) => x.trim()))].slice(0, 5000)
      if (!ids.length) throw new HttpError(400, 'holder_ids is empty — leave it out to cache every photo.')
    }
    const job = startImageJob(ctx, { holderIds: ids, force: b.force === true, user })
    return { job_id: job.id, job }
  })

  // Audit trail of applied scans and imports (the hyperMILL module lists all runs; this is the vendor view).
  r.get('/api/vendors/runs', (req) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.get('limit') ?? 20) || 20))
    return ctx.db
      .all<{ run_id: number; kind: string; source: string; interface_code: string; run_at: string; by_user: string; summary_json: string }>(
        `SELECT * FROM import_runs WHERE kind IN ('VENDOR','FILE') ORDER BY run_id DESC LIMIT ?`,
        [limit],
      )
      .map(({ summary_json, ...r }) => {
        let summary: unknown = null
        try {
          summary = JSON.parse(summary_json)
        } catch {
          summary = null
        }
        return { ...r, summary }
      })
  })
}
