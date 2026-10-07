/**
 * Where the catalogue keeps its data.
 *
 * Default on Windows: C:\Holder Catalogue — outside the user profile on purpose. A database inside
 * Documents or Desktop is usually synced by OneDrive, and a sync client copying a live SQLite file
 * corrupts it. The fallback when C:\ is not writable is %LOCALAPPDATA%\Holder Catalogue (never synced).
 *
 * Electron's userData folder holds only location.json, the pointer to the data folder.
 * HOLDER_CATALOGUE_DATA overrides everything (tests, a second copy for training).
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface Pointer {
  dataDir?: string
  /** App version that last opened the data — a change means an upgrade (take a backup first). */
  lastVersion?: string
  /** Loopback port used last time. Reusing it keeps the window's origin — and with it the remembered
   *  "who's booking", blind-count and count-location choices — the same from one launch to the next. */
  port?: number
}

export function readPointer(file: string): Pointer {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Pointer
  } catch {
    return {}
  }
}

export function writePointer(file: string, p: Pointer): void {
  writeFileSync(file, JSON.stringify(p, null, 2), 'utf8')
}

export function canWrite(dir: string): boolean {
  const probe = join(dir, `.write-test-${process.pid}`)
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    writeFileSync(probe, 'ok')
    return true
  } catch {
    return false
  } finally {
    try {
      rmSync(probe, { force: true })
    } catch {
      /* the folder was not writable in the first place */
    }
  }
}

/** \\server\share paths: SQLite over SMB corrupts under concurrent writers — warn loudly. */
export function isUncPath(p: string): boolean {
  return /^\\\\[^\\]/.test(p) || /^\/\/[^/]/.test(p)
}

export interface Resolution {
  dataDir: string
  source: 'env' | 'pointer' | 'default' | 'fallback'
  notice?: string
}

export function resolveDataDir(opts: {
  env: NodeJS.ProcessEnv
  pointer: Pointer
  platform: NodeJS.Platform
  home: string
  localAppData: string
}): Resolution {
  if (opts.env.HOLDER_CATALOGUE_DATA) return { dataDir: resolve(opts.env.HOLDER_CATALOGUE_DATA), source: 'env' }
  if (opts.pointer.dataDir) {
    // Never re-create a folder the app has used before: a missing folder is a disconnected drive or a
    // moved/deleted folder, and silently starting a fresh catalogue there would look like the data reset.
    if (existsSync(opts.pointer.dataDir) && canWrite(opts.pointer.dataDir)) return { dataDir: opts.pointer.dataDir, source: 'pointer' }
    throw new DataFolderUnavailableError(opts.pointer.dataDir)
  }
  const preferred = opts.platform === 'win32' ? 'C:\\Holder Catalogue' : join(opts.home, 'Holder Catalogue')
  if (canWrite(preferred)) return { dataDir: preferred, source: 'default' }
  const fallback = join(opts.localAppData, 'Holder Catalogue')
  if (!canWrite(fallback)) throw new DataFolderUnavailableError(fallback)
  return {
    dataDir: fallback,
    source: 'fallback',
    notice: `${preferred} could not be created, so the catalogue keeps its data in ${fallback}.`,
  }
}

export class DataFolderUnavailableError extends Error {
  constructor(readonly dir: string) {
    super(
      `The catalogue's data folder ${dir} cannot be reached or written.\n\n` +
        'If it is on a network drive or a USB disk, reconnect it and start the app again. ' +
        'To start over with a new data folder, delete location.json in %APPDATA%\\Holder Catalogue.',
    )
  }
}

export const DB_FILE = 'holder_catalogue.sqlite'
export const MOVED_NOTE = 'MOVED-TO.txt'

/** The new location recorded when the data was moved away from `dir`, if any. */
export function movedTo(dir: string): string | null {
  try {
    const target = readFileSync(join(dir, MOVED_NOTE), 'utf8').split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'))
    return target?.trim() || null
  } catch {
    return null
  }
}

/**
 * After a move, the old copy must not be opened by mistake (another Windows account, a lost location.json):
 * rename its database files and leave a note pointing at the new folder.
 */
export function retireOldCopy(dir: string, newDir: string): void {
  const stamp = new Date().toISOString().slice(0, 10)
  for (const suffix of ['', '-wal', '-shm']) {
    const f = join(dir, DB_FILE + suffix)
    if (existsSync(f)) renameSync(f, join(dir, `holder_catalogue.MOVED-${stamp}.sqlite${suffix}`))
  }
  writeFileSync(
    join(dir, MOVED_NOTE),
    `${newDir}\n# The Holder Catalogue data in this folder was moved there on ${stamp}.\n# The old database was renamed holder_catalogue.MOVED-${stamp}.sqlite and is kept only as a record.\n`,
    'utf8',
  )
}

/** OneDrive (personal or work) folders sync files behind the app's back — a live SQLite file gets corrupted. */
export function isOneDrivePath(p: string, env: NodeJS.ProcessEnv): boolean {
  const roots = [env.OneDrive, env.OneDriveCommercial, env.OneDriveConsumer].filter((r): r is string => !!r)
  const lower = p.toLowerCase()
  return roots.some((r) => lower === r.toLowerCase() || lower.startsWith(r.toLowerCase().replace(/[\\/]+$/, '') + '\\')) || /\\onedrive( - [^\\]+)?\\/i.test(p)
}

/** Windows: is the drive of `p` a network (mapped) drive? Uses .NET DriveInfo via PowerShell; false if unknown. */
export function isNetworkDrive(p: string): Promise<boolean> {
  const m = /^([a-zA-Z]):/.exec(p)
  if (process.platform !== 'win32' || !m) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `([System.IO.DriveInfo]::new('${m[1]}')).DriveType`],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => resolve(!err && /network/i.test(String(stdout))),
    )
  })
}

/** True when `dir` has no files (or does not exist). */
export function isEmptyDir(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0
}

/** Copies the whole data folder (database, images, backups, imports, logs) to an empty target. */
export function copyDataFolder(from: string, to: string): void {
  if (!isEmptyDir(to)) throw new Error(`${to} is not empty`)
  mkdirSync(to, { recursive: true })
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
}
