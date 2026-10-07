import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

/**
 * Tees console output into <data>/logs/main.log. A packaged Windows app has no terminal, so
 * without this a start-up failure on the shop PC leaves nothing to diagnose from. The previous
 * run is kept as main.previous.log so a crash-then-relaunch doesn't erase the evidence.
 */
export function startFileLog(logsDir: string): string {
  mkdirSync(logsDir, { recursive: true })
  const file = join(logsDir, 'main.log')
  if (existsSync(file)) renameSync(file, join(logsDir, 'main.previous.log'))
  const stream = createWriteStream(file, { flags: 'w' })
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      stream.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${format(...args)}\n`)
    }
  }
  return file
}
