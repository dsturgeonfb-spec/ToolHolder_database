// Shell: hash router, header, user picker, and the PIN sign-in for network clients.
// Each view is a module in ./views/<name>.js exporting:
//   export async function render(root, ctx)   // build the view into `root`
//   export function teardown() {}             // optional: stop timers/listeners
// ctx = { params: string[] (path segments after the view name), query: URLSearchParams,
//         api, state, navigate(hash), refreshSummary(), ensureUser() }
import { api, onUnauthorized } from './api.js'
import { esc, toastError } from './ui.js'
import { state, loadMeta, refreshSummary, initUser, chooseUser, ensureUser, setUser } from './state.js'

const VIEWS = {
  catalogue: 'catalogue',
  holder: 'holder',
  count: 'count',
  tally: 'tally',
  issues: 'issues',
  want: 'want',
  units: 'units',
  import: 'import',
  vendors: 'vendors',
  log: 'log',
  locations: 'locations',
  settings: 'settings',
}
// Which tab is highlighted for a route.
const TAB_OF = { holder: 'catalogue', locations: 'settings' }

let current = null
let renderSeq = 0

export function navigate(hash) {
  if (location.hash === hash) route()
  else location.hash = hash
}

async function route() {
  const seq = ++renderSeq
  const raw = location.hash.replace(/^#\/?/, '') || 'catalogue'
  const [pathPart, queryPart = ''] = raw.split('?')
  const segs = pathPart.split('/').filter(Boolean).map(decodeURIComponent)
  const name = VIEWS[segs[0]] ? segs[0] : 'catalogue'
  const root = document.getElementById('view')
  if (current?.mod?.teardown) {
    try {
      current.mod.teardown()
    } catch (e) {
      console.warn(e)
    }
  }
  const tab = TAB_OF[name] || name
  document.querySelectorAll('#tabs .tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)))
  root.innerHTML = '<div class="loading">Loading…</div>'
  try {
    const mod = await import(`./views/${VIEWS[name]}.js`)
    if (seq !== renderSeq) return
    current = { name, mod }
    root.innerHTML = ''
    await mod.render(root, {
      params: segs.slice(1),
      query: new URLSearchParams(queryPart),
      api,
      state,
      navigate,
      refreshSummary,
      ensureUser,
    })
  } catch (e) {
    if (seq !== renderSeq) return
    console.error(e)
    root.innerHTML = `<div class="errorbox">This view could not load: ${esc(e.message || e)}</div>`
  }
}

function showLogin() {
  if (document.querySelector('.login')) return
  const app = document.getElementById('app')
  app.innerHTML = `<form class="login card" id="loginForm">
      <h1>Holder Catalogue</h1>
      <p class="note" style="margin:0">This PC is using the catalogue over the network. Enter the PIN shown on the host PC (Settings → Share on network) and your name — your bookings are recorded under it.</p>
      <label class="fld req"><span>Your name</span><input name="name" autocomplete="name" required></label>
      <label class="fld req"><span>PIN</span><input name="pin" inputmode="numeric" autocomplete="one-time-code" required maxlength="6"></label>
      <div class="errorbox hidden" id="loginErr"></div>
      <button class="btn lg" type="submit">Sign in</button>
    </form>`
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = e.target
    try {
      await api.post('/api/login', { name: f.name.value, pin: f.pin.value })
      location.reload()
    } catch (err) {
      const box = document.getElementById('loginErr')
      box.textContent = err.message
      box.classList.remove('hidden')
    }
  })
}

async function boot() {
  initUser()
  onUnauthorized(showLogin)
  try {
    state.session = await api.get('/api/session')
  } catch (e) {
    document.getElementById('view').innerHTML = `<div class="errorbox">${esc(e.message)}</div>`
    return
  }
  if (!state.session.signedIn) return showLogin()
  if (!state.session.host) {
    // Network client: always books under its signed-in name.
    setUser(state.session.name)
    document.getElementById('hostBadge').textContent = 'network client'
  }
  try {
    await loadMeta()
  } catch (e) {
    toastError(e)
  }
  document.getElementById('userBtn').addEventListener('click', () => {
    if (state.session.host) chooseUser()
    else if (confirm('Sign out of this PC?')) api.post('/api/logout').then(() => location.reload())
  })
  window.addEventListener('hashchange', route)
  refreshSummary()
  await route()
  if (state.session.host && !state.user) chooseUser()
}

boot()
