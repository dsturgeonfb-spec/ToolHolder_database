// App-wide state: reference data (meta), the header summary, and who is booking.
import { api, setApiUser } from './api.js'
import { esc, formDialog, toastError } from './ui.js'

const USER_KEY = 'hc.user'
const subs = new Set()

export const state = {
  meta: null, // /api/meta
  summary: null, // /api/summary
  session: null, // /api/session
  user: '',
}

function readStoredUser() {
  try {
    return localStorage.getItem(USER_KEY) || ''
  } catch {
    return ''
  }
}

export function setUser(name) {
  state.user = (name || '').trim()
  setApiUser(state.user)
  try {
    if (state.user) localStorage.setItem(USER_KEY, state.user)
    else localStorage.removeItem(USER_KEY)
  } catch {}
  const btn = document.getElementById('userBtn')
  if (btn) {
    btn.classList.toggle('none', !state.user)
    document.getElementById('userName').textContent = state.user || "Who's booking?"
  }
}

/** Network clients book under the name they signed in with; the host PC picks a name here. */
export async function chooseUser() {
  if (state.session && !state.session.host) return state.user
  const users = state.meta?.settings?.users || []
  const listId = 'userlist'
  if (!document.getElementById(listId)) {
    const dl = document.createElement('datalist')
    dl.id = listId
    document.body.appendChild(dl)
  }
  document.getElementById(listId).innerHTML = users.map((u) => `<option value="${esc(u)}">`).join('')
  const res = await formDialog({
    title: "Who's booking?",
    intro: 'Every count, receipt, move and closed issue is recorded against a name (AS9100 traceability). Pick yours or type it.',
    fields: [{ name: 'name', label: 'Your name', required: true, value: state.user, list: listId, placeholder: 'e.g. D. Sturgeon' }],
    submitLabel: 'Use this name',
    onSubmit: async (v) => {
      const name = v.name.trim()
      setUser(name)
      if (!users.includes(name)) {
        try {
          const s = await api.put('/api/settings', { users: [...users, name] })
          if (state.meta) state.meta.settings = s
        } catch (e) {
          toastError(e)
        }
      }
      return name
    },
  })
  return res || state.user
}

/** Resolves with a user name, asking for one first if none is set. Returns '' if the person cancels. */
export async function ensureUser() {
  if (state.user) return state.user
  return chooseUser()
}

export async function loadMeta() {
  state.meta = await api.get('/api/meta')
  const iface = state.meta.interfaces.find((i) => i.interface_code === state.meta.settings.default_interface) || state.meta.interfaces[0]
  if (iface) {
    document.getElementById('ifaceCode').textContent = iface.interface_code
    document.getElementById('ifaceStd').textContent = `${iface.standard || ''} · gauge line = flange face`
  }
  return state.meta
}

export function typeName(code) {
  const t = state.meta?.types.find((x) => x.type_code === code)
  return t ? t.type_name : code
}

/** Re-reads the header numbers. Call after any write that changes stock or flags. */
export async function refreshSummary() {
  try {
    const s = await api.get('/api/summary')
    state.summary = s
    const set = (id, v) => {
      const el = document.getElementById(id)
      if (el) el.textContent = v
    }
    set('tTotal', s.holders_on_site)
    set('tArticles', s.articles_on_site)
    set('tCounted', `${s.counted_of_opening}/${s.to_count}`)
    set('tFlags', s.open_flags)
    set('tHigh', `${s.open_high} high`)
    set('nCat', s.articles_in_catalogue)
    set('nIss', s.open_flags)
    const m = document.getElementById('tMeter')
    if (m) m.style.width = (s.to_count ? Math.min(100, (s.counted_of_opening / s.to_count) * 100) : 0) + '%'
    subs.forEach((fn) => fn(s))
  } catch (e) {
    // Header numbers are informative; a failure here should not break the view.
    console.warn('summary failed', e)
  }
}
export function onSummary(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function initUser() {
  setUser(readStoredUser())
}
