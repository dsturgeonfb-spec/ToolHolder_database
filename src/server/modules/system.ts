/**
 * System: data folder facts, backups, opening folders on the host PC.
 *
 * Backups use `VACUUM INTO`, which writes a consistent, compacted copy of the live database
 * without stopping the app (SQLite's own online snapshot). The newest 30 are kept.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Router } from '../http.js'
import { HttpError } from '../http.js'
import type { AppContext } from '../context.js'
import { SCHEMA_VERSION } from '../db.js'

const KEEP_BACKUPS = 30
const BACKUP_RE = /^holder_catalogue-(\d{8})-(\d{6})(?:-[\w-]+)?\.sqlite$/

export interface BackupEntry {
  file: string
  path: string
  size: number
  created: string
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function listBackups(ctx: AppContext): BackupEntry[] {
  if (!existsSync(ctx.paths.backupsDir)) return []
  return readdirSync(ctx.paths.backupsDir)
    .filter((f) => BACKUP_RE.test(f))
    .map((f) => {
      const p = join(ctx.paths.backupsDir, f)
      const st = statSync(p)
      return { file: f, path: p, size: st.size, created: st.mtime.toISOString() }
    })
    .sort((a, b) => b.file.localeCompare(a.file))
}

/** Writes a consistent copy of the database into the backups folder and prunes old ones. */
export function makeBackup(ctx: AppContext, tag = ''): BackupEntry {
  let name = `holder_catalogue-${stamp()}${tag ? '-' + tag.replace(/[^\w]/g, '') : ''}.sqlite`
  let target = join(ctx.paths.backupsDir, name)
  // Two backups in the same second (a click right after the start-up backup) must not collide.
  for (let k = 2; existsSync(target); k++) {
    name = name.replace(/(-\d+)?\.sqlite$/, `-${k}.sqlite`)
    target = join(ctx.paths.backupsDir, name)
  }
  ctx.db.raw.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  const st = statSync(target)
  ctx.log('info', `Backup written: ${target} (${st.size} bytes)`)
  for (const old of listBackups(ctx).slice(KEEP_BACKUPS)) {
    try {
      rmSync(old.path)
    } catch (err) {
      ctx.log('warn', `Could not remove old backup ${old.path}: ${err}`)
    }
  }
  return { file: name, path: target, size: st.size, created: st.mtime.toISOString() }
}

/** The daily backup: makes one if the newest is older than `hours`. Returns it, or null when not due. */
export function backupIfDue(ctx: AppContext, hours = 20): BackupEntry | null {
  const newest = listBackups(ctx)[0]
  if (newest && Date.now() - new Date(newest.created).getTime() < hours * 3600_000) return null
  return makeBackup(ctx, 'auto')
}

export function register(r: Router, ctx: AppContext): void {
  r.get(
    '/api/system',
    () => {
      const backups = listBackups(ctx)
      let dbSizeBytes = 0
      try {
        dbSizeBytes = statSync(ctx.paths.dbPath).size
      } catch {
        /* reported as 0 */
      }
      return {
        version: ctx.version,
        schemaVersion: SCHEMA_VERSION,
        dataDir: ctx.paths.dataDir,
        dbPath: ctx.paths.dbPath,
        dbSizeBytes,
        backupsDir: ctx.paths.backupsDir,
        logsDir: ctx.paths.logsDir,
        importsDir: ctx.paths.importsDir,
        backups: backups.map(({ path: _p, ...b }) => b),
        lastBackup: backups[0]?.created ?? null,
        share: ctx.share.get(),
        platform: process.platform,
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        desktop: !!ctx.desktop,
      }
    },
    { hostOnly: true },
  )

  r.post(
    '/api/system/backup',
    () => {
      const b = makeBackup(ctx, 'manual')
      const { path: _p, ...rest } = b
      return rest
    },
    { hostOnly: true },
  )

  r.post(
    '/api/system/open',
    async (req) => {
      const what = String(req.body?.what ?? '')
      const dirs: Record<string, string> = {
        data: ctx.paths.dataDir,
        backups: ctx.paths.backupsDir,
        logs: ctx.paths.logsDir,
        imports: ctx.paths.importsDir,
      }
      const dir = dirs[what]
      if (!dir) throw new HttpError(400, `Unknown folder '${what}'`)
      if (!ctx.desktop) return { opened: false, path: dir }
      const err = await ctx.desktop.openPath(dir)
      if (err) throw new HttpError(500, `Windows could not open ${dir}: ${err}`)
      return { opened: true, path: dir }
    },
    { hostOnly: true },
  )
}
