/**
 * Writes an approved hyperMILL import plan — one database transaction for all of it.
 *
 * What it does (docs/API.md "hyperMILL import"; data rules BUILD_SPEC §3):
 *  - new holders: inserted as 'unverified' with the hyperMILL name/comment/GL/profile, an unverified
 *    OPENING_BALANCE of 1 at "Unassigned – count required", and an issue asking for the maker's data;
 *  - renamed / changed holders: only the CAM fields change, each change logged in holder_changes; renames
 *    and gauge-length changes raise an issue;
 *  - holders missing from the report: an issue — never deleted, stock never touched;
 *  - the report and its images are copied to <data>/imports/<YYYYMMDD-HHMMSS>/ and an import_runs row
 *    records the run.
 * Re-running the same report is a no-op: nothing is planned for unchanged holders, flags dedupe, and an
 * opening balance is only ever booked for a holder with no stock transactions at all.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { AppContext } from '../context.js'
import { logChange, nextHolderId, nowStamp, postTransaction, raiseFlag, today, unassignedLocationId, UNASSIGNED_LOCATION } from '../domain.js'
import { HttpError } from '../http.js'
import type { ParsedReport } from './parse.js'
import { sha256 } from './parse.js'
import { camImageName, planCounts, REMOVED_PREFIX, type Plan, type PlanMatched } from './plan.js'

export const SOURCE = 'hyperMILL import'
export const DATA_SOURCE = 'hyperMILL tool DB report'
const OPENING_NOTE = 'Unverified: holder exists in CAM DB; replace with physical count'

export interface ApplyResult {
  run_id: number
  /** Folder (relative to the data folder) holding the copied report and images. */
  folder: string
  report_date: string
  counts: ReturnType<typeof planCounts>
  new_holders: Array<{ holder_id: string; manufacturer: string; order_no: string; type_code: string }>
  updated_holders: Array<{ holder_id: string; manufacturer: string; order_no: string; fields: string[] }>
  new_manufacturers: string[]
  transactions: number
  flags_raised: number
  flags_existing: number
  changes_logged: number
}

const pad = (n: number) => String(n).padStart(2, '0')
/** DD/MM/YYYY (the shop's date format, as in the seed's opening-balance reference). */
export const ukDate = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
const folderStamp = (d: Date) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

/** Writes a file unless an identical one is already there. Returns true when it wrote one. */
function writeIfDifferent(path: string, bytes: Buffer): boolean {
  if (existsSync(path)) {
    try {
      if (sha256(readFileSync(path)) === sha256(bytes)) return false
    } catch {
      /* unreadable — overwrite below */
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return true
}

/** A path inside `root` for a relative name taken from the report; null if it would escape. */
function inside(root: string, rel: string): string | null {
  const full = resolve(root, rel)
  return full.startsWith(resolve(root) + sep) ? full : null
}

export function applyPlan(ctx: AppContext, report: ParsedReport, plan: Plan, user: string): ApplyResult {
  const db = ctx.db
  const now = new Date()
  const reportDate = ukDate(report.modified)
  const reference = `${DATA_SOURCE} ${reportDate}`
  const day = today(now)

  let folderName = folderStamp(now)
  for (let n = 2; existsSync(join(ctx.paths.importsDir, folderName)); n++) folderName = `${folderStamp(now)}-${n}`
  const folder = join(ctx.paths.importsDir, folderName)

  // Files written for this run; removed again if the transaction fails, so a failed import leaves nothing.
  const written: string[] = []
  const write = (path: string, bytes: Buffer) => {
    if (writeIfDifferent(path, bytes)) written.push(path)
  }

  const result: ApplyResult = {
    run_id: 0,
    folder: `imports/${folderName}`,
    report_date: reportDate,
    counts: planCounts(plan),
    new_holders: [],
    updated_holders: [],
    new_manufacturers: [],
    transactions: 0,
    flags_raised: 0,
    flags_existing: 0,
    changes_logged: 0,
  }
  const flag = (f: Parameters<typeof raiseFlag>[1]) => {
    const r = raiseFlag(db, { ...f, raised_by: user, source: SOURCE })
    if (r.created) result.flags_raised++
    else result.flags_existing++
  }
  const change = (holder_id: string, field: string, old_value: unknown, new_value: unknown) => {
    logChange(db, { holder_id, field, old_value, new_value, source: SOURCE, reference: report.path, by_user: user })
    result.changes_logged++
  }
  const imageBytes = (idx: number | null, sha: string | null): Buffer | null => {
    if (idx === null || !sha) return null
    const img = report.images[idx]
    return img?.bytes && img.sha256 === sha ? img.bytes : null
  }

  let unassigned: number | undefined
  const openingBalance = (holderId: string) => {
    // The guard that keeps re-imports idempotent: any stock history at all means no opening balance.
    if (Number(db.value(`SELECT COUNT(*) FROM stock_transactions WHERE holder_id = ?`, [holderId])) > 0) return
    unassigned ??= unassignedLocationId(db)
    if (unassigned === undefined)
      throw new HttpError(409, `The location "${UNASSIGNED_LOCATION}" is missing, and opening balances are booked there. Add it back under Settings → Locations, then apply again.`)
    postTransaction(db, {
      holder_id: holderId,
      location_id: unassigned,
      qty_delta: 1,
      txn_type: 'OPENING_BALANCE',
      reference,
      by_user: user,
      note: OPENING_NOTE,
    })
    result.transactions++
  }

  try {
    db.tx(() => {
      // ---- makers the catalogue does not have yet
      const makerId = new Map<string, number>()
      for (const n of plan.new) {
        if (makerId.has(n.manufacturer)) continue
        let id = db.value<number>(`SELECT manufacturer_id FROM manufacturers WHERE UPPER(name) = UPPER(?)`, [n.manufacturer])
        if (id === undefined) {
          const name = n.manufacturer.toUpperCase()
          id = db.run(`INSERT INTO manufacturers(name, is_distributor, notes) VALUES (?, 0, ?)`, [
            name,
            `Added by the hyperMILL import on ${ukDate(now)} (${user}) — add the website and order no. format.`,
          ]).lastInsertRowid
          result.new_manufacturers.push(name)
        }
        makerId.set(n.manufacturer, Number(id))
      }
      const makerFlagged = new Set<string>()

      // ---- new holders
      for (const n of plan.new) {
        const holderId = nextHolderId(db)
        let camImage: string | null = null
        const bytes = imageBytes(n.image, n.image_sha)
        if (bytes && n.image_sha) {
          camImage = camImageName(holderId, n.image_sha, n.image_ext ?? '.png')
          write(join(ctx.paths.dataDir, camImage), bytes)
        }
        const rec = {
          holder_id: holderId,
          manufacturer_id: makerId.get(n.manufacturer)!,
          order_no: n.order_no,
          type_code: n.type_code,
          interface_code: plan.interface_code,
          series: n.series,
          cam_name: n.cam_name,
          cam_comment: n.cam_comment,
          cam_gl_mm: n.cam_gl_mm,
          cam_image: camImage,
          data_status: 'unverified',
          data_source: DATA_SOURCE,
          last_checked: day,
        }
        const cols = Object.keys(rec) as Array<keyof typeof rec>
        db.run(`INSERT INTO holders(${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => rec[c]))
        const { holder_id: _id, manufacturer_id: _m, ...logged } = rec
        change(holderId, '*', null, { manufacturer: n.manufacturer, ...logged })
        openingBalance(holderId)
        const maker = n.manufacturer.toUpperCase()
        flag({
          holder_id: holderId,
          severity: 'INFO',
          category: 'Data source',
          message: `Added from the hyperMILL report of ${reportDate} — no maker data yet (gauge length, clamp Ø, nose Ø).`,
          action: `Run a vendor sync for ${maker} (Vendors tab) or enter the values from ${maker}'s catalogue, then set the data status.`,
        })
        if (result.new_manufacturers.includes(maker) && !makerFlagged.has(maker)) {
          makerFlagged.add(maker)
          flag({
            holder_id: holderId,
            severity: 'INFO',
            category: 'Data source',
            message: `New maker ${maker} added to the catalogue by the hyperMILL import.`,
            action: 'Check the maker name, add its website and order no. format, and whether it is a distributor.',
          })
        }
        if (n.type_code === 'OTHER')
          flag({
            holder_id: holderId,
            severity: 'MEDIUM',
            category: 'hyperMILL',
            message: `Holder type could not be worked out from the hyperMILL name "${n.cam_name}".`,
            action: 'Set the holder type on the holder page (Edit), and consider putting the type (SHRINK, HYDRAULIC, ER32…) in the hyperMILL name.',
          })
        result.new_holders.push({ holder_id: holderId, manufacturer: n.manufacturer, order_no: n.order_no, type_code: n.type_code })
      }

      // ---- renamed / changed holders: CAM fields only
      const update = (m: PlanMatched, renamed: boolean) => {
        for (const c of m.changes) {
          let value = c.new
          if (c.field === 'cam_image') {
            const bytes = imageBytes(m.image, m.image_sha)
            if (!bytes) continue
            write(join(ctx.paths.dataDir, String(c.new)), bytes)
          }
          if (c.field === 'cam_comment' && value === '') value = null
          db.run(`UPDATE holders SET ${c.field} = ? WHERE holder_id = ?`, [value, m.holder_id])
          change(m.holder_id, c.field, c.old, value)
        }
        if (renamed)
          flag({
            holder_id: m.holder_id,
            severity: 'LOW',
            category: 'hyperMILL',
            message: `Renamed in hyperMILL: ${m.old_name ?? '(no name)'} → ${m.cam_name}`,
            action: `Check it is still the same article (${m.manufacturer} ${m.order_no}) and update setup sheets or tool lists that use the old name.`,
          })
        const gl = m.changes.find((c) => c.field === 'cam_gl_mm')
        if (gl)
          flag({
            holder_id: m.holder_id,
            severity: 'MEDIUM',
            category: 'Gauge length',
            message:
              `hyperMILL gauge length changed: ${gl.old ?? 'none'} → ${gl.new} mm` +
              (m.gauge_length_mm != null ? ` (maker gauge length ${m.gauge_length_mm} mm).` : ' (no maker gauge length recorded).'),
            action: 'Check the holder model in hyperMILL against the maker drawing before relying on it for collision checks.',
          })
        if (m.opening_balance) openingBalance(m.holder_id)
        result.updated_holders.push({ holder_id: m.holder_id, manufacturer: m.manufacturer, order_no: m.order_no, fields: m.changes.map((c) => c.field) })
      }
      for (const m of plan.renamed) update(m, true)
      for (const m of plan.changed) update(m, false)

      // ---- holders the report no longer lists: an issue, nothing else
      for (const r of plan.removed) {
        // The message carries the report date, so raiseFlag's exact-message dedupe would not catch an issue
        // raised by an earlier report; the plan has already looked for one (open, or closed with nothing on site).
        if (r.already_flagged) {
          result.flags_existing++
          continue
        }
        flag({
          holder_id: r.holder_id,
          severity: 'LOW',
          category: 'hyperMILL',
          message: `${REMOVED_PREFIX} of ${reportDate} — removed from the CAM DB? Check stock and scrap/transfer`,
          action: 'If the holder has gone, book it out (scrap, or move it to "At vendor / repair"); if it is still in use, put it back in the hyperMILL tool database. Close this issue saying which.',
        })
      }

      // ---- traceability: the report as imported, and the run record
      mkdirSync(folder, { recursive: true })
      written.push(folder)
      writeFileSync(join(folder, report.file), report.bytes)
      report.images.forEach((img, i) => {
        if (!img.bytes || !img.path) return
        const target = (img.copyAs && inside(folder, img.copyAs)) || join(folder, '_external', `${i + 1}_${basename(img.path)}`)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, img.bytes)
      })
      const summary = {
        report: { path: report.path, file: report.file, format: report.format, date: reportDate, holders: report.holders.length },
        folder: result.folder,
        counts: result.counts,
        new_holders: result.new_holders.map((h) => h.holder_id),
        updated_holders: result.updated_holders.map((h) => h.holder_id),
        removed_holders: plan.removed.map((r) => r.holder_id),
        unmatched: plan.unmatched.map((u) => ({ seq: u.seq, cam_name: u.cam_name, reason: u.reason })),
        new_manufacturers: result.new_manufacturers,
        transactions: result.transactions,
        flags_raised: result.flags_raised,
        flags_existing: result.flags_existing,
        changes_logged: result.changes_logged,
        warnings: plan.warnings.length,
      }
      writeFileSync(join(folder, 'import-summary.json'), JSON.stringify({ ...summary, by: user, at: nowStamp(now), plan }, null, 1))
      result.run_id = db.run(
        `INSERT INTO import_runs(kind, source, interface_code, run_at, by_user, summary_json) VALUES ('HYPERMILL', ?, ?, ?, ?, ?)`,
        [report.path, plan.interface_code, nowStamp(now), user, JSON.stringify(summary)],
      ).lastInsertRowid
    })
  } catch (err) {
    for (const p of written.reverse()) {
      try {
        if (p === folder) rmSync(p, { recursive: true, force: true })
        else unlinkSync(p)
      } catch {
        /* best effort: an orphan image file is harmless */
      }
    }
    throw err
  }
  return result
}
