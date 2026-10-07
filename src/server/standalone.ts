/**
 * Runs the app server without Electron:
 *   node dist/src/server/standalone.js --data <folder> [--port 8763] [--share]
 *
 * Use it for development, for the end-to-end tests, or to run the catalogue on a shop PC that
 * stays on and serves the other PCs/tablets in a browser (the multi-user option in BUILD_SPEC §6).
 */
import { AppServer } from './app.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const dataDir = arg('data') ?? process.env.HOLDER_CATALOGUE_DATA ?? './.devdata'
const port = Number(arg('port') ?? process.env.PORT ?? 8763)
const app = new AppServer({ dataDir })
const actual = await app.listen(port)
console.log(`Holder Catalogue ${app.ctx.version} — http://127.0.0.1:${actual}/  (data: ${app.ctx.paths.dataDir})`)
if (process.argv.includes('--share')) {
  const s = await app.ctx.share.set({ enabled: true })
  console.log(`Shared on the network: ${s.urls.join(', ')}  PIN ${s.pin}`)
}

const stop = async () => {
  await app.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
