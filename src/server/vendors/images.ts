/**
 * Maker photo cache: downloads each holder's image_url into <data>/images/vendor/<holder_id>.<ext> so the
 * catalogue works offline and does not hot-link maker sites. Same polite fetcher (robots.txt, crawl delay,
 * honest user agent). Only from makers with an automated adapter, and only from that adapter's own site
 * (BUILD_SPEC §4: "only from adapters that expose image URLs in HTML"); any other address — a distributor's
 * CDN, a link typed into a holder or a CSV file — is listed as skipped with the reason. Only real images are
 * kept: Content-Type image/jpeg|png|webp|gif, the bytes must look like that format, at most 5 MB.
 * Writes files only — never catalogue or stock data.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext } from '../context.js'
import type { JobState } from '../jobs.js'
import { HttpError } from '../http.js'
import { BlockedError, VendorFetchError } from './fetcher.js'
import { makeFetcher } from './hooks.js'
import { allPhotoOrigins, photoSource } from './registry.js'

export const IMAGES_KIND = 'vendor-images'
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }
const ALL_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif']

/** Checks the first bytes really are the format the server claims (a login page sent as image/jpeg is refused). */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return null
}

function cachedFile(dir: string, holderId: string): string | null {
  for (const e of ALL_EXT) if (existsSync(join(dir, `${holderId}.${e}`))) return `${holderId}.${e}`
  return null
}

export interface ImageJobResult {
  downloaded: Array<{ holder_id: string; file: string; bytes: number }>
  /**
   * Not downloaded, with the reason. kind: 'cached' = already saved (use force to replace), 'not_allowed' =
   * no automated adapter for that maker or the address is not on its site, 'blocked' = the site refused earlier.
   */
  skipped: Array<{ holder_id: string; reason: string; kind: 'cached' | 'not_allowed' | 'blocked' }>
  failed: Array<{ holder_id: string; url: string; error: string }>
  blocked_hosts: string[]
}

export function startImageJob(ctx: AppContext, o: { holderIds: string[] | null; force: boolean; user: string }): JobState {
  if (ctx.jobs.list().some((j) => j.kind === IMAGES_KIND && j.status === 'running'))
    throw new HttpError(409, 'Maker photos are already being downloaded — wait for that job or cancel it.')
  const where = o.holderIds ? `AND h.holder_id IN (${o.holderIds.map(() => '?').join(',')})` : ''
  const rows = ctx.db.all<{ holder_id: string; image_url: string; maker: string }>(
    `SELECT h.holder_id, h.image_url, m.name AS maker FROM holders h JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
     WHERE h.image_url IS NOT NULL AND TRIM(h.image_url) <> '' ${where} ORDER BY h.holder_id`,
    o.holderIds ?? [],
  )
  if (o.holderIds) {
    const found = new Set(rows.map((r) => r.holder_id))
    const missing = o.holderIds.filter((id) => !found.has(id))
    if (missing.length && !rows.length) throw new HttpError(400, `None of these holders has a maker photo address: ${missing.slice(0, 10).join(', ')}. Run a vendor scan first.`)
  }
  if (!rows.length) throw new HttpError(400, 'No holder has a maker photo address yet — run a vendor scan (or import a file with image_url) first.')
  const dir = join(ctx.paths.imagesDir, 'vendor')
  mkdirSync(dir, { recursive: true })

  return ctx.jobs.start(IMAGES_KIND, `Cache maker photos (${rows.length})`, async (job) => {
    // Only the photo sites of makers with an automated adapter; each download is narrowed to its own maker's site.
    const fetcher = makeFetcher(ctx, { origins: allPhotoOrigins(), signal: job.signal, log: (m) => job.log(m) })
    const res: ImageJobResult = { downloaded: [], skipped: [], failed: [], blocked_hosts: [] }
    job.log(`Started by ${o.user}. ${rows.length} holders have a photo address; photos are only downloaded from ${fetcher.allowedOrigins.map((x) => new URL(x).host).join(', ') || 'no site'}.`)
    for (let i = 0; i < rows.length; i++) {
      if (job.signal.aborted) break
      const { holder_id: id, image_url: url, maker } = rows[i]!
      job.progress(i, rows.length, `${id} (${i + 1} of ${rows.length})`)
      const src = photoSource(maker, url)
      if (!src.ok) {
        res.skipped.push({ holder_id: id, reason: src.reason, kind: 'not_allowed' })
        job.log(`${id}: skipped — ${src.reason}`)
        continue
      }
      const have = cachedFile(dir, id)
      if (have && !o.force) {
        res.skipped.push({ holder_id: id, reason: `already cached (${have})`, kind: 'cached' })
        continue
      }
      let host = ''
      try {
        const u = new URL(url)
        host = u.host
        if (res.blocked_hosts.includes(host)) {
          res.skipped.push({ holder_id: id, reason: `${host} blocked automated access earlier in this job`, kind: 'blocked' })
          continue
        }
        const r = await fetcher.get(url, { accept: 'image/jpeg,image/png,image/webp,image/gif', maxBytes: MAX_IMAGE_BYTES, origins: src.origins })
        fetcher.assertOk(r)
        const type = r.contentType.split(';')[0]!.trim().toLowerCase()
        const ext = EXT[type]
        if (!ext) throw new VendorFetchError(`not an image (the site sent ${type || 'no content type'}) — not saved`, 'http')
        const sniffed = sniffImage(r.body)
        if (!sniffed) throw new VendorFetchError(`the file does not look like a ${ext.toUpperCase()} image — not saved`, 'http')
        const file = `${id}.${sniffed}`
        const tmp = join(dir, `.${file}.part`)
        writeFileSync(tmp, r.body)
        // Replace an older copy in another format so the catalogue never shows a stale photo.
        for (const e of ALL_EXT) if (e !== sniffed && existsSync(join(dir, `${id}.${e}`))) unlinkSync(join(dir, `${id}.${e}`))
        renameSync(tmp, join(dir, file))
        res.downloaded.push({ holder_id: id, file, bytes: r.body.length })
        job.log(`${id}: saved ${file} (${Math.round(r.body.length / 1024)} KB)`)
      } catch (err) {
        if (job.signal.aborted || (err instanceof VendorFetchError && err.kind === 'cancelled')) break
        const msg = (err as Error).message
        if (err instanceof BlockedError && host && !res.blocked_hosts.includes(host)) res.blocked_hosts.push(host)
        res.failed.push({ holder_id: id, url, error: msg })
        job.log(`${id}: ${msg}`)
      }
    }
    // Leftover partial files from an interrupted run are not photos.
    for (const f of readdirSync(dir)) if (f.endsWith('.part')) unlinkSync(join(dir, f))
    job.progress(rows.length, rows.length, job.signal.aborted ? 'Cancelled' : 'Done')
    job.log(`Done: ${res.downloaded.length} saved, ${res.skipped.length} skipped, ${res.failed.length} failed.`)
    return res
  })
}
