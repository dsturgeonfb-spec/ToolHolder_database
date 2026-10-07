/**
 * Holder Catalogue — Electron main process.
 *
 * Starts the app server in-process (no child processes: the database is node:sqlite, built into
 * Electron's Node), then shows it in a window. One instance per PC: a second launch focuses the
 * first, because two processes must never write the same SQLite file.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type MenuItemConstructorOptions, type OpenDialogOptions } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppServer } from '../server/app.js'
import { makeBackup } from '../server/modules/system.js'
import { startFileLog } from './log.js'
import {
  DB_FILE,
  DataFolderUnavailableError,
  copyDataFolder,
  isEmptyDir,
  isNetworkDrive,
  isOneDrivePath,
  isUncPath,
  movedTo,
  readPointer,
  resolveDataDir,
  retireOldCopy,
  writePointer,
  type Pointer,
} from './data-folder.js'

const APP_NAME = 'Holder Catalogue'
app.setName(APP_NAME)
// Dates are day-month-year in the shop; Chromium would otherwise take the locale from Windows.
app.commandLine.appendSwitch('lang', 'en-GB')

let server: AppServer | null = null
let mainWindow: BrowserWindow | null = null
let quitting = false
let origin = ''

const pointerFile = () => join(app.getPath('userData'), 'location.json')

// A training/test copy (HOLDER_CATALOGUE_DATA) gets its own Electron profile and single-instance lock, so it can
// run beside the real catalogue instead of silently focusing it.
const envData = process.env.HOLDER_CATALOGUE_DATA ? resolve(process.env.HOLDER_CATALOGUE_DATA) : null
if (envData) app.setPath('userData', join(envData, '.electron'))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => fatal('Holder Catalogue could not start', err))
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (quitting || !server) return
    quitting = true
    event.preventDefault()
    const s = server
    server = null
    void s.close().finally(() => app.quit())
  })
}

async function start(): Promise<void> {
  const pointer = readPointer(pointerFile())
  let resolution
  try {
    resolution = resolveDataDir({
      env: process.env,
      pointer,
      platform: process.platform,
      home: app.getPath('home'),
      localAppData: process.env.LOCALAPPDATA ?? app.getPath('appData'),
    })
  } catch (err) {
    if (err instanceof DataFolderUnavailableError) return recoverDataFolder(err.dir, 'unreachable')
    throw err
  }
  const dataDir = resolution.dataDir
  // The app has run on this folder before but the database is gone: never quietly seed a fresh one.
  if (!existsSync(join(dataDir, DB_FILE)) && resolution.source !== 'env') {
    const moved = movedTo(dataDir)
    if (moved) return followMove(dataDir, moved)
    if (pointer.lastVersion && resolution.source === 'pointer') return recoverDataFolder(dataDir, 'missing-db')
  }
  const logFile = startFileLog(join(dataDir, 'logs'))
  console.log(`[main] ${APP_NAME} ${app.getVersion()} on Electron ${process.versions.electron} (Node ${process.versions.node}); log ${logFile}`)
  console.log(`[main] data folder ${dataDir} (${resolution.source})`)
  if (resolution.notice) console.warn(`[main] ${resolution.notice}`)
  // Informational only (the data lock is what enforces one PC) — so it never delays the window.
  const sharedWarning = () => console.warn(`[main] the data folder ${dataDir} is on a network drive or OneDrive — only this PC may open it (the data lock enforces that)`)
  if (isUncPath(dataDir) || isOneDrivePath(dataDir, process.env)) sharedWarning()
  else void isNetworkDrive(dataDir).then((net) => net && sharedWarning())

  // An upgrade migrates the database: copy it first, while nothing has it open.
  const dbPath = join(dataDir, 'holder_catalogue.sqlite')
  if (existsSync(dbPath) && pointer.lastVersion && pointer.lastVersion !== app.getVersion()) {
    const dir = join(dataDir, 'backups', 'pre-upgrade')
    mkdirSync(dir, { recursive: true })
    const base = join(dir, `holder_catalogue-before-${app.getVersion()}-from-${pointer.lastVersion}.sqlite`)
    copyFileSync(dbPath, base)
    if (existsSync(dbPath + '-wal')) copyFileSync(dbPath + '-wal', base + '-wal')
    console.log(`[main] upgrade ${pointer.lastVersion} → ${app.getVersion()}: database copied to ${base}`)
  }

  const appRoot = app.getAppPath()
  const seedDir = app.isPackaged ? join(process.resourcesPath, 'seed') : appRoot
  try {
    server = new AppServer({
      dataDir,
      appRoot,
      seedDir,
      version: app.getVersion(),
      log: (level, message) => (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[server] ${message}`),
    })
    server.ctx.desktop = {
      openPath: (p) => shell.openPath(p),
      showItemInFolder: (p) => shell.showItemInFolder(p),
    }
    // Same port as last time when free: the window's origin (and its remembered choices) stays the same.
    let port: number
    try {
      port = await server.listen(pointer.port && !envData ? pointer.port : 0)
    } catch (err) {
      // Taken (EADDRINUSE) or reserved since the last run (Windows excluded port ranges → EACCES): any free port will do.
      if (!pointer.port || envData) throw err
      console.warn(`[main] remembered port ${pointer.port} unavailable (${(err as NodeJS.ErrnoException).code ?? err}); using a new one`)
      port = await server.listen(0)
    }
    origin = `http://127.0.0.1:${port}`
    console.log(`[main] app server ${origin}`)
  } catch (err) {
    fatal('The catalogue database could not be opened', err)
    return
  }
  if (resolution.source !== 'env') writePointer(pointerFile(), { ...pointer, dataDir, lastVersion: app.getVersion(), port: server.port })

  installIpc()
  installMenu()
  installNavigationGuards()

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    title: envData ? `${APP_NAME} — ${basename(envData)} (separate data folder)` : APP_NAME,
    icon: join(appRoot, 'buildResources', 'icon.png'),
    backgroundColor: '#F2F4F6',
    webPreferences: {
      preload: join(fileURLToPath(new URL('.', import.meta.url)), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.on('closed', () => (mainWindow = null))
  // Keep the separate-data-folder title (the page's <title> would replace it).
  if (envData) mainWindow.on('page-title-updated', (e) => e.preventDefault())
  await mainWindow.loadURL(`${origin}/`)
  // The daily backup runs inside the app server (3 s after start, then hourly).
}

/**
 * The data folder the app used before can't be opened (drive disconnected, folder moved or deleted, database
 * file missing). Ask — never start an empty catalogue behind the person's back.
 */
async function recoverDataFolder(dir: string, why: 'unreachable' | 'missing-db'): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Holder Catalogue — data not found',
    message: why === 'unreachable' ? `The data folder ${dir} can't be reached.` : `The catalogue database is missing from ${dir}.`,
    detail:
      (why === 'unreachable'
        ? 'If it is on a network drive or USB disk, reconnect it and press Try again.'
        : `The file ${DB_FILE} is not in that folder. If it was moved, choose its new folder. To restore a backup, copy one from the backups folder there and rename it ${DB_FILE}, then press Try again.`) +
      '\n\nStart a new catalogue only if you really mean to begin again from the seeded holder list.',
    buttons: ['Try again', 'Choose the folder…', 'Start a new catalogue…', 'Quit'],
    defaultId: 0,
    cancelId: 3,
  })
  if (response === 0) return relaunch()
  if (response === 3) return exitApp(0)
  const pick = await dialog.showOpenDialog({
    title: response === 1 ? 'Choose the folder that holds holder_catalogue.sqlite' : 'Choose an EMPTY folder for a new catalogue',
    properties: ['openDirectory', 'createDirectory'],
  })
  const target = pick.canceled ? null : (pick.filePaths[0] ?? null)
  if (!target) return recoverDataFolder(dir, why)
  if (response === 1 && !existsSync(join(target, DB_FILE))) {
    await dialog.showMessageBox({ type: 'error', title: 'No catalogue there', message: `${target} does not contain ${DB_FILE}.` })
    return recoverDataFolder(dir, why)
  }
  if (response === 2 && !isEmptyDir(target)) {
    await dialog.showMessageBox({ type: 'error', title: 'Folder not empty', message: 'Choose an empty folder for a new catalogue.' })
    return recoverDataFolder(dir, why)
  }
  if (isOneDrivePath(target, process.env)) {
    await dialog.showMessageBox({ type: 'error', title: 'Not a OneDrive folder', message: 'Choose a folder outside OneDrive — it copies the database while the app has it open, which corrupts it.' })
    return recoverDataFolder(dir, why)
  }
  if (isUncPath(target) || (await isNetworkDrive(target))) {
    const { response: go } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Network folder',
      message: 'That is a network folder. Only ONE PC may ever run the app against it.',
      detail: 'For several users keep the data on one PC and turn on Settings → Share on network there.',
      buttons: ['Use it anyway', 'Choose another'],
      defaultId: 1,
      cancelId: 1,
    })
    if (go !== 0) return recoverDataFolder(dir, why)
  }
  // A new catalogue is a first run in that folder: drop lastVersion so the next start seeds it instead of
  // reporting the (deliberately) missing database again.
  const { lastVersion: _lv, ...rest } = readPointer(pointerFile())
  writePointer(pointerFile(), response === 2 ? { ...rest, dataDir: target } : { ...rest, lastVersion: _lv, dataDir: target })
  relaunch()
}

/** The folder holds a MOVED-TO note: offer to switch to where the data went. */
async function followMove(dir: string, target: string): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Holder Catalogue was moved',
    message: `The catalogue in ${dir} was moved to ${target}.`,
    detail: 'Use the catalogue in its new folder?',
    buttons: ['Use the new folder', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) return exitApp(0)
  writePointer(pointerFile(), { ...readPointer(pointerFile()), dataDir: target })
  relaunch()
}

function relaunch(): void {
  app.relaunch()
  exitApp(0)
}

function exitApp(code: number): void {
  quitting = true
  app.exit(code)
}

function installIpc(): void {
  ipcMain.on('desktop:version', (e) => (e.returnValue = app.getVersion()))
  ipcMain.handle('desktop:pickFile', async (e, opts: { title?: string; filters?: OpenDialogOptions['filters']; defaultPath?: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: opts?.title ?? 'Choose a file',
      defaultPath: opts?.defaultPath,
      filters: opts?.filters,
      properties: ['openFile'],
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle('desktop:openExternal', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened')
    await shell.openExternal(url)
  })
  ipcMain.handle('desktop:showItemInFolder', (_e, p: string) => shell.showItemInFolder(p))
}

/** Web links open in the system browser; the app's own printable pages open in a plain child window. */
function installNavigationGuards(): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(origin + '/')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1000,
            height: 900,
            autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        }
      }
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (ev, url) => {
      if (url.startsWith(origin + '/')) return
      ev.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    })
  })
  // Exports arrive as downloads: always ask where to save (Electron would otherwise prompt only sometimes).
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Save export', defaultPath: join(app.getPath('downloads'), item.getFilename()) })
  })
}

function installMenu(): void {
  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'Back up now', click: () => backUpNow() },
      { label: 'Open backups folder', click: () => server && void shell.openPath(server.ctx.paths.backupsDir) },
      { type: 'separator' },
      { label: 'Open data folder', click: () => server && void shell.openPath(server.ctx.paths.dataDir) },
      { label: 'Move data folder…', click: () => void moveDataFolder() },
      { label: 'Open log folder', click: () => server && void shell.openPath(server.ctx.paths.logsDir) },
      { type: 'separator' },
      { role: 'quit', label: 'Exit' },
    ],
  }
  const help: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      {
        label: `About ${APP_NAME}`,
        click: () =>
          void dialog.showMessageBox(mainWindow!, {
            type: 'info',
            title: APP_NAME,
            message: `${APP_NAME} ${app.getVersion()}`,
            detail: `Tool-holder catalogue and stock tally.\n\nData folder: ${server?.ctx.paths.dataDir ?? '?'}\nElectron ${process.versions.electron} · Node ${process.versions.node}`,
          }),
      },
    ],
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([file, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }, help]))
}

function backUpNow(): void {
  if (!server) return
  try {
    const b = makeBackup(server.ctx, 'manual')
    void dialog.showMessageBox(mainWindow!, { type: 'info', title: 'Backup written', message: 'The database was backed up.', detail: b.path })
  } catch (err) {
    void dialog.showMessageBox(mainWindow!, { type: 'error', title: 'Backup failed', message: String(err) })
  }
}

/**
 * Moves the data to another folder chosen in the native picker (a typed path is how data ends up
 * somewhere nobody meant). The server is stopped first — the database cannot be open while copied.
 * If the chosen folder already holds a catalogue, the app switches to it instead of copying.
 */
async function moveDataFolder(): Promise<void> {
  if (!server || !mainWindow) return
  const current = server.ctx.paths.dataDir
  const pick = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the new data folder (an empty folder, or one that already holds a Holder Catalogue)',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (pick.canceled || !pick.filePaths[0]) return
  const target = pick.filePaths[0]
  if (target === current) return
  const existing = existsSync(join(target, 'holder_catalogue.sqlite'))
  if (!existing && !isEmptyDir(target)) {
    await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Folder not empty', message: 'Choose an empty folder, or a folder that already holds a Holder Catalogue database.' })
    return
  }
  if (isOneDrivePath(target, process.env)) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Not a OneDrive folder',
      message: 'Choose a folder outside OneDrive.',
      detail: 'OneDrive copies files while the app has them open, which corrupts the database. Use a local folder (e.g. C:\\Holder Catalogue) and let the daily backups go to the server instead.',
    })
    return
  }
  const unc = isUncPath(target) || (await isNetworkDrive(target))
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: unc ? 'warning' : 'question',
    buttons: [existing ? 'Switch to that catalogue' : 'Copy and switch', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Move data folder',
    message: existing ? `Use the catalogue already in ${target}?` : `Copy the catalogue to ${target} and use it from there?`,
    detail:
      (unc
        ? 'That is a network folder. Only ONE PC may ever run the app against it — SQLite on a shared drive corrupts when two PCs write. For several users, keep the data on one PC and turn on Settings → Share on network instead.\n\n'
        : '') +
      (existing
        ? `The app restarts afterwards. The current folder (${current}) is left as it is.`
        : `The app restarts afterwards. In the old folder (${current}) the database is renamed holder_catalogue.MOVED-<date>.sqlite and a MOVED-TO note points to the new folder, so nobody opens the old copy by mistake.`),
  })
  if (response !== 0) return
  const s = server
  server = null
  await s.close()
  let stage: 'copy' | 'pointer' | 'retire' = 'copy'
  try {
    if (!existing) copyDataFolder(current, target)
    stage = 'pointer'
    const pointer: Pointer = { ...readPointer(pointerFile()), dataDir: target, lastVersion: app.getVersion() }
    writePointer(pointerFile(), pointer)
    // Only once the app points at the new copy: the old one must not be opened again by mistake.
    stage = 'retire'
    if (!existing) retireOldCopy(current, target)
  } catch (err) {
    const detail =
      stage === 'copy'
        ? 'Nothing was changed; the app restarts on the old folder. (A partial copy may be left in the new folder — delete it before trying again.)'
        : stage === 'pointer'
          ? 'The data was copied, but the app could not record the new folder; it restarts on the old folder.'
          : `The catalogue now runs from ${target}, but the old database in ${current} could not be renamed — rename or delete holder_catalogue.sqlite there by hand so nobody opens it by mistake.`
    await dialog.showMessageBox(mainWindow, { type: 'error', title: stage === 'retire' ? 'Moved — old copy not retired' : 'Move failed', message: String(err), detail })
  }
  app.relaunch()
  quitting = true
  app.exit(0)
}

function fatal(headline: string, err: unknown): void {
  const detail = err instanceof DataFolderUnavailableError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`[main] ${headline}`, err)
  dialog.showErrorBox(headline, detail)
  quitting = true
  app.exit(1)
}
