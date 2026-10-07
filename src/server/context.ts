import type { Db } from './db.js'
import type { Jobs } from './jobs.js'

export interface AppPaths {
  /** Folder holding package.json, ui/, db/schema.sql (the repo root, or app.asar when packaged). */
  appRoot: string
  uiDir: string
  schemaPath: string
  /** Where the seed database and CAM images come from on first run. */
  seedDir: string
  /** The user's data folder: database, images, backups, logs, imported reports. */
  dataDir: string
  dbPath: string
  imagesDir: string
  backupsDir: string
  logsDir: string
  importsDir: string
}

export interface ShareState {
  enabled: boolean
  port: number
  pin: string | null
  /** http://<lan-ip>:<port> addresses other PCs/tablets on the network can open. */
  urls: string[]
  error?: string
}

export type LogLevel = 'info' | 'warn' | 'error'
export type Logger = (level: LogLevel, message: string) => void

export interface AppContext {
  db: Db
  paths: AppPaths
  version: string
  jobs: Jobs
  log: Logger
  /** Network sharing (other PCs / shop-floor tablets). Managed by the server; host-only to change. */
  share: {
    get(): ShareState
    set(opts: { enabled: boolean; port?: number; regeneratePin?: boolean }): Promise<ShareState>
  }
  /** Set by the Electron host so the UI can offer native features; absent in the standalone server. */
  desktop?: {
    openPath(path: string): Promise<string>
    showItemInFolder(path: string): void
  }
}
