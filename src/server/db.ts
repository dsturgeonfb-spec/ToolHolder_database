/**
 * SQLite access on Node's built-in `node:sqlite` (no native module, so the Electron
 * build needs no ABI rebuild). One connection per process; the app server is the only writer.
 *
 * db/schema.sql is the source of truth for the data model. `migrate()` applies it to any
 * database (fresh or the seeded one), adds columns that later schema versions introduced,
 * and recreates the views so a changed view definition always takes effect.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

export type Param = SQLInputValue | boolean | undefined
export type Params = Param[] | Record<string, Param>
export type Row = Record<string, unknown>

export class Db {
  readonly raw: DatabaseSync
  private readonly cache = new Map<string, StatementSync>()
  private depth = 0

  constructor(path: string) {
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA foreign_keys = ON')
    this.raw.exec('PRAGMA busy_timeout = 5000')
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL')
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  all<T = Row>(sql: string, params?: Params): T[] {
    const s = this.stmt(sql)
    return (Array.isArray(params) || params === undefined ? s.all(...bindList(params)) : s.all(bindNamed(params))) as T[]
  }

  get<T = Row>(sql: string, params?: Params): T | undefined {
    const s = this.stmt(sql)
    return (Array.isArray(params) || params === undefined ? s.get(...bindList(params)) : s.get(bindNamed(params))) as T | undefined
  }

  /** First column of the first row, or undefined. */
  value<T = unknown>(sql: string, params?: Params): T | undefined {
    const r = this.get<Row>(sql, params)
    return r ? (Object.values(r)[0] as T) : undefined
  }

  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
    const s = this.stmt(sql)
    const r = Array.isArray(params) || params === undefined ? s.run(...bindList(params)) : s.run(bindNamed(params))
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  /**
   * Runs `fn` in a transaction (BEGIN IMMEDIATE, so a writer never deadlocks on upgrade).
   * Nested calls use savepoints. `fn` must be synchronous — node:sqlite is synchronous.
   */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0
    const sp = `sp_${this.depth}`
    this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`)
    this.depth++
    try {
      const out = fn()
      if (out instanceof Promise) throw new Error('Db.tx callback must be synchronous')
      this.depth--
      this.raw.exec(outer ? 'COMMIT' : `RELEASE ${sp}`)
      return out
    } catch (err) {
      this.depth--
      try {
        this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`)
      } catch {
        // The transaction may already be gone (e.g. SQLite rolled back on its own).
      }
      throw err
    }
  }

  close(): void {
    this.cache.clear()
    this.raw.close()
  }
}

function bindValue(v: Param): SQLInputValue {
  if (v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  return v
}
function bindList(params?: Param[]): SQLInputValue[] {
  return (params ?? []).map(bindValue)
}
function bindNamed(params: Record<string, Param>): Record<string, SQLInputValue> {
  const out: Record<string, SQLInputValue> = {}
  for (const [k, v] of Object.entries(params)) out[k] = bindValue(v)
  return out
}

export function openDatabase(path: string): Db {
  return new Db(path)
}

/** Columns added to existing tables after schema v1. Fresh databases get them from schema.sql directly. */
const ADDED_COLUMNS: Array<[table: string, column: string, decl: string]> = [
  ['data_flags', 'raised_by', 'TEXT'],
  ['data_flags', 'source', 'TEXT'],
  ['data_flags', 'close_note', 'TEXT'],
  ['stock_transactions', 'created_at', 'TEXT'],
  ['holder_units', 'inspected_by', 'TEXT'],
  ['wishlist', 'added_by', 'TEXT'],
  ['wishlist', 'updated_on', 'TEXT'],
]

export const SCHEMA_VERSION = 2

/**
 * Brings any database up to the current schema. Safe to run on every start.
 * Order matters: tables first (IF NOT EXISTS), then missing columns, then views
 * (dropped and recreated — they are derived, so this loses nothing).
 */
export function migrate(db: Db, schemaSql: string): void {
  const tablesPart = schemaSql.replace(/CREATE VIEW IF NOT EXISTS[\s\S]*?;\s*(?=\n|$)/g, '')
  db.tx(() => {
    db.exec(tablesPart)
    for (const [table, column, decl] of ADDED_COLUMNS) {
      const cols = db.all<{ name: string }>(`PRAGMA table_info(${table})`)
      if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
    }
    for (const m of schemaSql.matchAll(/CREATE VIEW IF NOT EXISTS (\w+) AS[\s\S]*?;\s*(?=\n|$)/g)) {
      db.exec(`DROP VIEW IF EXISTS ${m[1]}`)
      db.exec(m[0])
    }
    // Reference data the app relies on that the v1 seed did not have.
    db.run(
      `INSERT OR IGNORE INTO holder_types(type_code, type_name, clamping_principle, sort_order)
       VALUES ('OTHER', 'Other / unclassified', 'Needs classifying', 99)`,
    )
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })
}
