/**
 * Opens XLSX exports with Python's openpyxl when it is installed — the strongest check, short of Excel,
 * that a workbook is well formed. Python is looked up ONCE, asynchronously, when a test file loads: a
 * synchronous spawn blocks the test process, which also runs the test server. On Windows `python3` can be
 * the Microsoft Store stub that takes seconds to fail, and a 14 s block once made the server drop a
 * keep-alive connection that the next request then reused ("fetch failed").
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function find(): Promise<string | null> {
  const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']
  for (const cmd of candidates) {
    try {
      await run(cmd, ['-I', '-c', 'import openpyxl'], { timeout: 20_000, windowsHide: true })
      return cmd
    } catch {
      // not installed, no openpyxl, or the Store stub — try the next one
    }
  }
  return null
}

/** The python command that has openpyxl, or null (tests then skip the openpyxl check). */
export const PYTHON: string | null = await find()

/** Runs a short python program (isolated mode) and returns its stdout. */
export async function runPython(code: string, args: string[]): Promise<string> {
  if (!PYTHON) throw new Error('python with openpyxl is not available')
  const { stdout } = await run(PYTHON, ['-I', '-c', code, ...args], { timeout: 60_000, windowsHide: true, maxBuffer: 20_000_000 })
  return stdout
}
