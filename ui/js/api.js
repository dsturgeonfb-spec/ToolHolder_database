// API client for the app's own server. Every request carries the CSRF header and the name of
// the person booking (X-User). Errors become ApiError with the server's plain-English message.

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

let currentUser = ''
/** Set by state.js whenever the person booking changes. */
export function setApiUser(name) {
  currentUser = name || ''
}

const listeners = { unauthorized: [] }
export function onUnauthorized(fn) {
  listeners.unauthorized.push(fn)
}

async function request(method, path, body, opts = {}) {
  const headers = { 'X-Requested-With': 'HolderCatalogue' }
  if (currentUser) headers['X-User'] = encodeURIComponent(currentUser)
  let payload
  if (opts.raw !== undefined) {
    payload = opts.raw
    headers['Content-Type'] = opts.contentType || 'text/plain; charset=utf-8'
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  let res
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' })
  } catch (e) {
    throw new ApiError(0, 'Cannot reach the catalogue server. If this is a network PC, check the host PC is on and sharing.')
  }
  if (res.status === 401) listeners.unauthorized.forEach((fn) => fn())
  if (res.status === 204) return null
  const type = res.headers.get('content-type') || ''
  const data = type.includes('application/json') ? await res.json() : await res.text()
  if (!res.ok) {
    const msg = (data && data.error) || (typeof data === 'string' && data) || `Request failed (${res.status})`
    throw new ApiError(res.status, msg, data && data.details)
  }
  return data
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path, body) => request('DELETE', path, body),
  /** POST raw text (CSV import etc.). */
  postText: (path, text, contentType) => request('POST', path, undefined, { raw: text, contentType }),

  /**
   * Downloads a file the server generates (CSV/XLSX). Uses fetch so the X-User header goes along,
   * then saves via a temporary link — in the desktop app this opens the Save dialog.
   */
  async download(path, fallbackName = 'export') {
    const headers = { 'X-Requested-With': 'HolderCatalogue' }
    if (currentUser) headers['X-User'] = encodeURIComponent(currentUser)
    const res = await fetch(path, { headers, credentials: 'same-origin' })
    if (!res.ok) {
      let msg = `Download failed (${res.status})`
      try {
        msg = (await res.json()).error || msg
      } catch {}
      throw new ApiError(res.status, msg)
    }
    const cd = res.headers.get('content-disposition') || ''
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="([^"]+)"/i.exec(cd)
    const name = m ? decodeURIComponent(m[1]) : fallbackName
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    return name
  },

  /** Opens a printable page (count sheet, RFQ, write-back list) in a new window. */
  openPrintable(path) {
    window.open(path, '_blank', 'noopener')
  },
}
