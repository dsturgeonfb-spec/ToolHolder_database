// Settings: people who book, locations, network sharing, data folder & backups, vendor sync,
// serialised-unit inspection interval, about. Host-only sections are hidden on network clients.
import { esc, fmtDate, toast, toastError, confirmDialog, formDialog, emptyHTML } from '../ui.js'
import { state, loadMeta } from '../state.js'
import { api } from '../api.js'

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const when = (iso) => {
  if (!iso) return 'never'
  const d = new Date(iso)
  return `${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

export async function render(root, ctx) {
  const host = !!state.session?.host
  root.innerHTML = `
    <div class="view-head"><div><h2>Settings</h2><p class="muted">How this catalogue is set up. Changes are recorded against the person booking.</p></div></div>
    <div class="grid2">
      <section class="card" id="sPeople"></section>
      <section class="card" id="sLocations"></section>
      ${host ? `<section class="card" id="sShare"></section><section class="card" id="sData"></section>` : ''}
      <section class="card" id="sVendor"></section>
      <section class="card" id="sAbout"></section>
    </div>`
  await Promise.all([renderPeople(root, ctx), renderLocations(root), host ? renderShare(root) : null, host ? renderData(root) : null, renderVendor(root, ctx), renderAbout(root, host)])
}

async function saveSettings(patch) {
  const s = await api.put('/api/settings', patch)
  if (state.meta) state.meta.settings = s
  return s
}

async function renderPeople(root, ctx) {
  const box = root.querySelector('#sPeople')
  const users = state.meta?.settings?.users || []
  box.innerHTML = `<h2>People who book</h2>
    <p class="note" style="margin:0">Names offered in "Who's booking?". Every count, receipt, move, closed issue and catalogue edit records the name. Removing a name here does not change past records.</p>
    ${users.length ? `<table class="data"><tbody>${users.map((u) => `<tr><td>${esc(u)}</td><td class="actions"><button class="btn ghost sm danger" data-rm="${esc(u)}" type="button">Remove</button></td></tr>`).join('')}</tbody></table>` : emptyHTML('No names yet — a name is added when someone picks it in “Who\'s booking?” on this PC, or here.')}
    <div class="btnrow"><button class="btn sm" type="button" data-add>Add a name</button></div>`
  box.onclick = async (e) => {
    const rm = e.target.closest('[data-rm]')
    if (e.target.closest('[data-add]')) {
      const who = await ctx.ensureUser()
      if (!who) return
      await formDialog({
        title: 'Add a name',
        fields: [{ name: 'name', label: 'Name', required: true }],
        submitLabel: 'Add',
        onSubmit: async (v) => saveSettings({ users: [...users, v.name] }),
      })
      return renderPeople(root, ctx)
    }
    if (rm) {
      const who = await ctx.ensureUser()
      if (!who) return
      try {
        await saveSettings({ users: users.filter((u) => u !== rm.dataset.rm) })
        renderPeople(root, ctx)
      } catch (err) {
        toastError(err)
      }
    }
  }
}

async function renderLocations(root) {
  const box = root.querySelector('#sLocations')
  const locs = state.meta?.locations || []
  box.innerHTML = `<h2>Locations</h2>
    <p class="note" style="margin:0">Where holders are kept: the crib, machine magazines, the presetter, out for repair. "Counts as on site" decides whether a location is in the site tally.</p>
    <table class="data"><thead><tr><th>Location</th><th>Kind</th><th>On site?</th></tr></thead><tbody>
      ${locs.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.kind || '')}</td><td>${l.counts_as_on_site ? 'Yes' : '<span class="muted">No</span>'}</td></tr>`).join('')}
    </tbody></table>
    <div class="btnrow"><a class="btn sm" href="#/locations">Manage locations</a></div>`
}

async function renderShare(root) {
  const box = root.querySelector('#sShare')
  let s
  try {
    s = await api.get('/api/system/share')
  } catch (e) {
    box.innerHTML = `<h2>Share on network</h2><div class="errorbox">${esc(e.message)}</div>`
    return
  }
  box.innerHTML = `<h2>Share on network</h2>
    <p class="note" style="margin:0">Lets other PCs and shop-floor tablets use this catalogue in a web browser — e.g. for counting at the crib. This PC stays the only one that writes the database, so nothing gets corrupted. Others sign in with the PIN and their name; their bookings are recorded under that name.</p>
    <label class="chk"><input type="checkbox" id="shareOn" ${s.enabled ? 'checked' : ''}> Share this catalogue on the network</label>
    <div class="row2 form" style="flex-direction:row;gap:12px;align-items:flex-end">
      <label class="fld" style="max-width:160px"><span>Port</span><input id="sharePort" type="number" min="1024" max="65535" value="${esc(s.port)}"></label>
      <div class="fld" style="max-width:200px"><span>PIN</span><div class="mono" style="font-size:26px;letter-spacing:.15em">${esc(s.pin || '––––––')}</div></div>
      <button class="btn ghost sm" type="button" id="newPin">New PIN (signs everyone out)</button>
    </div>
    ${s.enabled ? `<div class="okbox">On. Other devices open: ${s.urls.length ? s.urls.map((u) => `<b class="mono">${esc(u)}</b>`).join(' or ') : '(no network address found)'}</div>
      <p class="note tiny" style="margin:0">If a device can't connect, Windows Firewall may be blocking the port — allow "Holder Catalogue" on private networks when Windows asks, or ask IT to open TCP ${esc(s.port)} on this PC. Keep it on the shop network only; never forward this port to the internet.</p>` : ''}
    ${s.error ? `<div class="errorbox">${esc(s.error)}</div>` : ''}`
  const apply = async (patch) => {
    try {
      await api.put('/api/system/share', { enabled: box.querySelector('#shareOn').checked, port: Number(box.querySelector('#sharePort').value), ...patch })
      toast('Network sharing updated', 'ok')
    } catch (e) {
      toastError(e)
    }
    renderShare(root)
  }
  box.querySelector('#shareOn').addEventListener('change', () => apply({}))
  box.querySelector('#sharePort').addEventListener('change', () => box.querySelector('#shareOn').checked && apply({}))
  box.querySelector('#newPin').addEventListener('click', async () => {
    if (await confirmDialog('New PIN', 'Every device signed in over the network will have to sign in again with the new PIN.', { ok: 'Make a new PIN' })) apply({ regeneratePin: true })
  })
}

async function renderData(root) {
  const box = root.querySelector('#sData')
  let s
  try {
    s = await api.get('/api/system')
  } catch (e) {
    box.innerHTML = `<h2>Data & backups</h2><div class="errorbox">${esc(e.message)}</div>`
    return
  }
  const stale = !s.lastBackup || Date.now() - new Date(s.lastBackup).getTime() > 3 * 24 * 3600_000
  box.innerHTML = `<h2>Data & backups</h2>
    <dl class="kv">
      <dt>Data folder</dt><dd class="mono">${esc(s.dataDir)}</dd>
      <dt>Database</dt><dd>${kb(s.dbSizeBytes)} · schema v${esc(s.schemaVersion)}</dd>
      <dt>Last backup</dt><dd>${esc(when(s.lastBackup))}</dd>
      <dt>Backups kept</dt><dd>${s.backups.length} (newest 30 kept; one is made automatically each day the app runs)</dd>
    </dl>
    ${stale ? `<div class="warnbox">No backup in the last 3 days. Press "Back up now", and make sure the backups folder is copied off this PC by your normal server backup.</div>` : ''}
    <div class="btnrow">
      <button class="btn sm" type="button" data-backup>Back up now</button>
      ${s.desktop ? `<button class="btn ghost sm" type="button" data-open="data">Open data folder</button><button class="btn ghost sm" type="button" data-open="backups">Open backups</button><button class="btn ghost sm" type="button" data-open="logs">Open logs</button>` : ''}
    </div>
    <details><summary class="small">Recent backups</summary>
      <table class="data small"><thead><tr><th>File</th><th class="n">Size</th></tr></thead><tbody>
      ${s.backups.slice(0, 10).map((b) => `<tr><td class="mono">${esc(b.file)}</td><td class="n">${kb(b.size)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">None yet</td></tr>'}
      </tbody></table></details>
    <details><summary class="small">How to restore a backup</summary>
      <ol class="small" style="margin:6px 0 0;padding-left:18px">
        <li>Close Holder Catalogue.</li>
        <li>In the data folder, rename <span class="mono">holder_catalogue.sqlite</span> <b>and</b> its <span class="mono">-wal</span> and <span class="mono">-shm</span> files to the same new name (e.g. <span class="mono">holder_catalogue-old.sqlite</span>, <span class="mono">holder_catalogue-old.sqlite-wal</span>) — they belong together; never delete a -wal file on its own.</li>
        <li>Copy the backup you want from <span class="mono">backups\\</span> into the data folder and rename it <span class="mono">holder_catalogue.sqlite</span>.</li>
        <li>Start the app. Use File → Move data folder… to put the data somewhere else.</li>
      </ol></details>`
  box.onclick = async (e) => {
    if (e.target.closest('[data-backup]')) {
      try {
        const b = await api.post('/api/system/backup')
        toast(`Backed up: ${b.file}`, 'ok')
        renderData(root)
      } catch (err) {
        toastError(err)
      }
    }
    const o = e.target.closest('[data-open]')
    if (o) api.post('/api/system/open', { what: o.dataset.open }).catch(toastError)
  }
}

async function renderVendor(root, ctx) {
  const box = root.querySelector('#sVendor')
  const st = state.meta?.settings || {}
  const ifaces = state.meta?.interfaces || []
  box.innerHTML = `<h2>Catalogue & vendor sync</h2>
    <form class="form" id="vendorForm">
      <label class="fld"><span>Taper form you command</span><select name="default_interface">${ifaces.map((i) => `<option value="${esc(i.interface_code)}" ${i.interface_code === st.default_interface ? 'selected' : ''}>${esc(i.interface_code)} — ${esc(i.standard || '')}</option>`).join('')}</select>
        <span class="help">Default for imports and vendor scans. The database can hold any interface.</span></label>
      <label class="fld"><span>Contact e-mail sent to maker websites</span><input name="vendor_contact" type="email" value="${esc(st.vendor_contact || '')}" placeholder="engineering@yourcompany.com">
        <span class="help">Vendor scans identify themselves honestly (app name + this address) and respect each site's robots.txt and crawl delay.</span></label>
      <label class="fld"><span>Serialised holders: inspection interval (days)</span><input name="unit_inspection_days" type="number" min="1" max="3650" value="${esc(st.unit_inspection_days ?? 180)}"></label>
      <div class="btnrow"><button class="btn sm" type="submit">Save</button></div>
    </form>`
  box.querySelector('#vendorForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const who = await ctx.ensureUser()
    if (!who) return
    const f = e.target
    try {
      await saveSettings({ default_interface: f.default_interface.value, vendor_contact: f.vendor_contact.value, unit_inspection_days: Number(f.unit_inspection_days.value) })
      await loadMeta()
      toast('Settings saved', 'ok')
    } catch (err) {
      toastError(err)
    }
  })
}

function renderAbout(root, host) {
  const box = root.querySelector('#sAbout')
  const v = state.meta?.version || ''
  box.innerHTML = `<h2>About</h2>
    <dl class="kv">
      <dt>Version</dt><dd>${esc(v)}${window.desktop ? ' (desktop app)' : host ? ' (browser on the host PC)' : ' (network client)'}</dd>
      <dt>Data rules</dt><dd>Stock is the sum of booked transactions — never typed over. Catalogue values come from maker pages and catalogues, with their source and the date checked. Gauge length = HSK gauge line (flange face) to the holder nose; hyperMILL's own value is kept separately.</dd>
    </dl>`
}
