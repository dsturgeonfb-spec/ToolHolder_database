/**
 * hyperMILL report import: parse → preview → apply (docs/API.md "hyperMILL import").
 *
 * Preview reads a report on the host's disk and returns what an import would do, with a token; nothing
 * is written. Apply re-plans against the catalogue as it is now and writes only if that plan is still the
 * one the person approved. Both read a path on the host PC, so network clients are refused.
 * The work lives in ../hypermill/*; this file maps routes to it.
 */
import type { AppContext } from '../context.js'
import { getSetting, requireUser } from '../domain.js'
import { Download, HttpError, int, optStr, type Router } from '../http.js'
import { applyPlan, ukDate } from '../hypermill/apply.js'
import { findReport, readReportFile } from '../hypermill/parse.js'
import { buildPlan, planCounts, planFingerprint, planHasWork, type PlanMatched, type PlanNew } from '../hypermill/plan.js'
import { PreviewStore, type PreviewEntry } from '../hypermill/previews.js'

const RUN_KINDS = ['HYPERMILL', 'VENDOR', 'FILE']

export function register(r: Router, ctx: AppContext): void {
  const previews = new PreviewStore()
  const db = ctx.db

  const imageUrl = (token: string, idx: number | null) => (idx === null ? null : `/api/import/hypermill/preview/${token}/images/${idx}`)

  const previewResponse = (e: PreviewEntry) => {
    const { warnings: planWarnings, ...plan } = e.plan
    const withImage = <T extends PlanNew | PlanMatched>(x: T) => ({ ...x, image_url: imageUrl(e.token, x.image) })
    return {
      token: e.token,
      expires_at: new Date(e.expires).toISOString(),
      report: {
        path: e.report.path,
        file: e.report.file,
        format: e.report.format,
        title: e.report.title,
        date: ukDate(e.report.modified),
        holders: e.report.holders.length,
        images: e.report.holders.filter((h) => h.image !== null).length,
      },
      plan: {
        ...plan,
        new: plan.new.map(withImage),
        renamed: plan.renamed.map(withImage),
        changed: plan.changed.map(withImage),
      },
      counts: planCounts(e.plan),
      has_work: planHasWork(e.plan),
      warnings: [...e.report.warnings, ...planWarnings],
    }
  }

  r.post(
    '/api/import/hypermill/preview',
    (req) => {
      const b = req.body && typeof req.body === 'object' ? req.body : {}
      const input = optStr(b.path, 2000)
      if (!input) throw new HttpError(400, 'Enter the path of the hyperMILL report (the .html file), or use "Choose report…".')
      const iface = optStr(b.interface_code, 40) ?? getSetting<string>(db, 'default_interface', 'HSK-A63')
      if (!db.value(`SELECT 1 FROM interfaces WHERE interface_code = ?`, [iface]))
        throw new HttpError(400, `Unknown interface "${iface}". Pick one of the listed interfaces.`)
      const found = findReport(input)
      if ('error' in found) throw new HttpError(400, found.error)
      let report
      try {
        report = readReportFile(found.path)
      } catch (err) {
        throw new HttpError(400, `Could not read ${found.path}: ${err instanceof Error ? err.message : String(err)}. Close it in other programs and try again.`)
      }
      if (!report.holders.length)
        throw new HttpError(
          400,
          `No holders found in ${report.file}. Is it the hyperMILL tool database "Holder" report? Each holder in it starts with "Holder:".`,
        )
      const plan = buildPlan(db, ctx.paths.dataDir, report, iface)
      const entry = previews.add(report, plan, planFingerprint(plan))
      return previewResponse(entry)
    },
    { hostOnly: true },
  )

  r.post(
    '/api/import/hypermill/apply',
    (req) => {
      const user = requireUser(req.user)
      const token = optStr(req.body?.token, 100)
      if (!token) throw new HttpError(400, 'Preview the report first — apply needs the preview token.')
      const entry = previews.get(token)
      if (!entry) throw new HttpError(404, 'This preview has expired or was already applied — preview the report again.')
      // Re-plan against the catalogue as it is now: someone may have edited, counted or imported since.
      const fresh = buildPlan(db, ctx.paths.dataDir, entry.report, entry.plan.interface_code)
      if (planFingerprint(fresh) !== entry.fingerprint) {
        previews.delete(token)
        throw new HttpError(409, 'The catalogue changed since the preview — preview again.')
      }
      const result = applyPlan(ctx, entry.report, fresh, user)
      previews.delete(token)
      const c = result.counts
      ctx.log(
        'info',
        `hyperMILL import by ${user} from ${entry.report.path}: ${c.new} new, ${c.renamed} renamed, ${c.changed} changed, ${c.removed} removed, ${c.unchanged} unchanged, ${c.unmatched} unmatched (run ${result.run_id})`,
      )
      return result
    },
    { hostOnly: true },
  )

  // Profile pictures for the preview screen — only the ones a live preview parsed, never an arbitrary file.
  r.get(
    '/api/import/hypermill/preview/:token/images/:n',
    (req) => {
      const entry = previews.get(req.params.token!)
      if (!entry) throw new HttpError(404, 'This preview has expired — preview the report again.')
      const n = int(req.params.n, 'Image number')
      const img = entry.report.holders.some((h) => h.image === n) ? entry.report.images[n] : undefined
      if (!img?.bytes) throw new HttpError(404, 'No such image in this preview.')
      return new Download(`hypermill-profile-${n}${img.ext}`, img.mime, img.bytes, 'inline')
    },
    { hostOnly: true },
  )

  r.get('/api/import/runs', (req) => {
    const kind = (req.query.get('kind') ?? '').trim().toUpperCase()
    if (kind && !RUN_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${RUN_KINDS.join(', ')}`)
    const limitRaw = (req.query.get('limit') ?? '').trim()
    const limit = limitRaw ? int(limitRaw, 'limit') : 200
    if (limit < 1 || limit > 1000) throw new HttpError(400, 'limit must be between 1 and 1000')
    const rows = db.all<Record<string, unknown> & { summary_json: string | null }>(
      `SELECT * FROM import_runs ${kind ? 'WHERE kind = ?' : ''} ORDER BY run_id DESC LIMIT ?`,
      kind ? [kind, limit] : [limit],
    )
    return rows.map(({ summary_json, ...run }) => {
      let summary: unknown = null
      try {
        summary = summary_json ? JSON.parse(summary_json) : null
      } catch {
        summary = null
      }
      return { ...run, summary }
    })
  })
}
