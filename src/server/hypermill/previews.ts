/**
 * Previews waiting for approval, in memory. A preview keeps the report bytes and images it parsed, so
 * apply writes exactly what the person looked at even if the file on disk changes in between.
 */
import { randomBytes } from 'node:crypto'
import type { ParsedReport } from './parse.js'
import type { Plan } from './plan.js'

export const PREVIEW_TTL_MS = 60 * 60 * 1000
/** Each preview holds a report and its images in memory; a few are plenty for one person at the host PC. */
const MAX_PREVIEWS = 8

export interface PreviewEntry {
  token: string
  report: ParsedReport
  plan: Plan
  fingerprint: string
  created: number
  expires: number
}

export class PreviewStore {
  private entries = new Map<string, PreviewEntry>()

  constructor(private readonly ttlMs = PREVIEW_TTL_MS) {}

  add(report: ParsedReport, plan: Plan, fingerprint: string): PreviewEntry {
    this.purge()
    while (this.entries.size >= MAX_PREVIEWS) this.entries.delete(this.entries.keys().next().value!)
    const now = Date.now()
    const entry: PreviewEntry = { token: randomBytes(16).toString('hex'), report, plan, fingerprint, created: now, expires: now + this.ttlMs }
    this.entries.set(entry.token, entry)
    return entry
  }

  get(token: string): PreviewEntry | undefined {
    this.purge()
    return this.entries.get(token)
  }

  delete(token: string): void {
    this.entries.delete(token)
  }

  private purge(): void {
    const now = Date.now()
    for (const [k, e] of this.entries) if (e.expires <= now) this.entries.delete(k)
  }
}
