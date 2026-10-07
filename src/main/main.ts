/**
 * Holder Catalogue — Electron main process.
 *
 * Starts the app server in-process (no child processes: the database is node:sqlite, built into
 * Electron's Node), then shows it in a window. One instance per PC: a second launch focuses the
 * first, because two processes must never write the same SQLite file.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type MenuItemConstructorOptions, type OpenDialogOptions } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppServer } from '../server/app.js'
import { backupIfDue, makeBackup } from '../server/modules/system.js'
import { startFileLog } from './log.js'
import {
  DataFolderUnavailableError,
  copyDataFolder,
  isEmptyDir,
  isUncPath,
  readPointer,
  resolveDataDir,
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

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(start, (err: unknown) => fatal('Holder Catalogue could not start', err))
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
    fatal('Holder Catalogue cannot find its data', err)
    return
  }
  const dataDir = resolution.dataDir
  const logFile = startFileLog(join(dataDir, 'logs'))
  console.log(`[main] ${APP_NAME} ${app.getVersion()} on Electron ${process.versions.electron} (Node ${process.versions.node}); log ${logFile}`)
  console.log(`[main] data folder ${dataDir} (${resolution.source})`)
  if (resolution.notice) console.warn(`[main] ${resolution.notice}`)

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
    const port = await server.listen(0)
    origin = `http://127.0.0.1:${port}`
    console.log(`[main] app server ${origin}`)
  } catch (err) {
    fatal('The catalogue database could not be opened', err)
    return
  }
  if (resolution.source !== 'env') writePointer(pointerFile(), { ...pointer, dataDir, lastVersion: app.getVersion() })

  installIpc()
  installMenu()
  installNavigationGuards()

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    title: APP_NAME,
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
  await mainWindow.loadURL(`${origin}/`)

  // The daily backup, after the window is up so a slow disk doesn't delay the start.
  setTimeout(() => {
    try {
      if (server) backupIfDue(server.ctx)
    } catch (err) {
      console.error('[main] daily backup failed', err)
    }
  }, 3000)
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
  const unc = isUncPath(target)
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
        : '') + `The app restarts afterwards. The old folder (${current}) is left as it is.`,
  })
  if (response !== 0) return
  const s = server
  server = null
  await s.close()
  try {
    if (!existing) copyDataFolder(current, target)
    const pointer: Pointer = { ...readPointer(pointerFile()), dataDir: target, lastVersion: app.getVersion() }
    writePointer(pointerFile(), pointer)
  } catch (err) {
    await dialog.showMessageBox(mainWindow, { type: 'error', title: 'Move failed', message: String(err), detail: 'Nothing was changed; the app restarts on the old folder.' })
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
