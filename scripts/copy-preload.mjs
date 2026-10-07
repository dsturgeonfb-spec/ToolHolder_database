// The Electron preload runs sandboxed, so it must be CommonJS and is not compiled by tsc.
// Copy it next to the compiled main process.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src', 'main', 'preload.cjs')
const dst = join(root, 'dist', 'src', 'main', 'preload.cjs')
if (existsSync(src)) {
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
}
