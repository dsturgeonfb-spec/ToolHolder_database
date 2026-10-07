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
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface Pointer {
  dataDir?: string
  /** App version that last opened the data — a change means an upgrade (take a backup first). */
  lastVersion?: string
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
    if (canWrite(opts.pointer.dataDir)) return { dataDir: opts.pointer.dataDir, source: 'pointer' }
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
