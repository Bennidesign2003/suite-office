import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, WebContentsView } from 'electron'
import {
  installRendererProtocol,
  registerRendererScheme,
  rendererUrl,
  safeExternalUrl,
} from '@genoffice/electron-utils'
import {
  MAIL_CHANNELS,
  type MailModule,
  type MailAccountInput,
  type MailResult,
  type OutgoingMail,
} from '../shared/ipc'
import { AccountStore } from './accounts'
import {
  attachmentContent,
  closeAll,
  deleteMessages,
  dropClient,
  getMessage,
  listFolders,
  listMessages,
  markAnswered,
  moveMessages,
  sendMail,
  setFlags,
  testAccount,
  type Credentials,
} from './mailbox'
import { registerPimIpc } from './pim/pim-ipc'
import { guessServers } from './presets'

interface MailRuntime {
  preloadPath: string
  rendererUrl?: string
  rendererFile: string
  /** bring a mail tab to the front on the given module (set by the shell) */
  openModule?: (module: MailModule) => void
  /** the suite's UI language, for texts the main process writes */
  language?: () => string
}

let runtime: MailRuntime = {
  preloadPath: join(__dirname, '../preload/index.js'),
  rendererFile: join(__dirname, '../renderer/index.html'),
}

export function configureMailRuntime(next: MailRuntime): void {
  runtime = next
}

let accountStore: AccountStore | null = null

/** created on first use: importing this module must not touch Electron APIs */
function accounts(): AccountStore {
  accountStore ??= new AccountStore(
    () => join(app.getPath('userData'), 'mail-accounts.json'),
    safeStorage,
  )
  return accountStore
}

function credentials(accountId: string): Credentials {
  const account = accounts().get(accountId)
  if (!account) throw new Error('Dieses Konto gibt es nicht mehr.')
  const password = accounts().password(account)
  if (!password) throw new Error('Für dieses Konto ist kein Passwort gespeichert.')
  return { account, password }
}

async function result<T>(work: () => Promise<T>): Promise<MailResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function validAccount(input: MailAccountInput): string | null {
  if (!/^[^@\s]+@[^@\s]+$/.test(input.email.trim()))
    return 'Bitte eine gültige E-Mail-Adresse eingeben.'
  for (const [label, server] of [
    ['IMAP', input.imap],
    ['SMTP', input.smtp],
  ] as const) {
    if (!server.host.trim()) return `${label}-Server fehlt.`
    if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
      return `${label}-Port ist ungültig.`
    }
  }
  return null
}

let ipcRegistered = false

export function registerMailIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.handle(MAIL_CHANNELS.listAccounts, () => accounts().list())

  ipcMain.handle(MAIL_CHANNELS.guessServers, (_e, email: string) =>
    guessServers(String(email ?? '')),
  )

  ipcMain.handle(MAIL_CHANNELS.testAccount, (_e, input: MailAccountInput) =>
    result(async () => {
      const invalid = validAccount(input)
      if (invalid) throw new Error(invalid)
      const account = accounts().resolve(input)
      const password = input.password || accounts().password(account)
      if (!password) throw new Error('Bitte das Passwort eingeben.')
      await testAccount(account, password)
      return undefined
    }),
  )

  ipcMain.handle(MAIL_CHANNELS.saveAccount, (_e, input: MailAccountInput) =>
    result(async () => {
      const invalid = validAccount(input)
      if (invalid) throw new Error(invalid)
      const account = accounts().resolve(input)
      if (!accounts().password(account)) throw new Error('Bitte das Passwort eingeben.')
      dropClient(account.id)
      return accounts().save(account)
    }),
  )

  ipcMain.handle(MAIL_CHANNELS.removeAccount, (_e, id: string) => {
    dropClient(id)
    accounts().remove(id)
  })

  ipcMain.handle(MAIL_CHANNELS.listFolders, (_e, accountId: string) =>
    result(() => listFolders(credentials(accountId))),
  )

  ipcMain.handle(
    MAIL_CHANNELS.listMessages,
    (
      _e,
      accountId: string,
      folder: string,
      options: { page: number; pageSize: number; query?: string },
    ) => result(() => listMessages(credentials(accountId), folder, options)),
  )

  ipcMain.handle(MAIL_CHANNELS.getMessage, (_e, accountId: string, folder: string, uid: number) =>
    result(() => getMessage(credentials(accountId), folder, uid)),
  )

  ipcMain.handle(
    MAIL_CHANNELS.setFlags,
    (
      _e,
      accountId: string,
      folder: string,
      uids: number[],
      flag: 'seen' | 'flagged',
      on: boolean,
    ) => result(() => setFlags(credentials(accountId), folder, uids, flag, on)),
  )

  ipcMain.handle(
    MAIL_CHANNELS.moveMessages,
    (_e, accountId: string, folder: string, uids: number[], target: string) =>
      result(() => moveMessages(credentials(accountId), folder, uids, target)),
  )

  ipcMain.handle(
    MAIL_CHANNELS.deleteMessages,
    (_e, accountId: string, folder: string, uids: number[]) =>
      result(() => deleteMessages(credentials(accountId), folder, uids)),
  )

  ipcMain.handle(
    MAIL_CHANNELS.saveAttachment,
    (e, accountId: string, folder: string, uid: number, index: number) =>
      result(async () => {
        const { filename, content } = await attachmentContent(
          credentials(accountId),
          folder,
          uid,
          index,
        )
        const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
        const picked = await (win
          ? dialog.showSaveDialog(win, { defaultPath: join(app.getPath('downloads'), filename) })
          : dialog.showSaveDialog({ defaultPath: join(app.getPath('downloads'), filename) }))
        if (picked.canceled || !picked.filePath) return ''
        await writeFile(picked.filePath, content)
        return picked.filePath
      }),
  )

  ipcMain.handle(MAIL_CHANNELS.pickAttachments, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const options = {
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    }
    const picked = await (win
      ? dialog.showOpenDialog(win, options)
      : dialog.showOpenDialog(options))
    return picked.canceled ? [] : picked.filePaths
  })

  ipcMain.handle(MAIL_CHANNELS.send, (_e, mail: OutgoingMail) =>
    result(async () => {
      if (!mail.to?.trim()) throw new Error('Bitte mindestens einen Empfänger angeben.')
      const creds = credentials(mail.accountId)
      await sendMail(creds, mail)
      if (mail.answering) await markAnswered(creds, mail.answering.folder, mail.answering.uid)
      return undefined
    }),
  )

  ipcMain.handle(MAIL_CHANNELS.initialModule, (e): MailModule => {
    const module = initialModules.get(e.sender.id) ?? 'mail'
    initialModules.delete(e.sender.id)
    return module
  })

  registerPimIpc({
    accounts,
    credentials,
    secretBox: () => safeStorage,
    openCalendar: () => openModule('calendar'),
    language: () => runtime.language?.() ?? app.getLocale(),
  })

  app.on('before-quit', () => void closeAll())
}

/** the part a freshly created tab opens on, until its page asks */
const initialModules = new Map<number, MailModule>()

/** the shell's tab, or (standalone) whatever mail window is open */
function openModule(module: MailModule): void {
  if (runtime.openModule) {
    runtime.openModule(module)
    return
  }
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  showMailModule(win.webContents, module)
}

/** switch an open mail tab to mail, calendar or contacts */
export function showMailModule(wc: Electron.WebContents, module: MailModule): void {
  if (!wc.isDestroyed()) wc.send(MAIL_CHANNELS.showModule, module)
}

function guardNavigation(view: WebContentsView): void {
  view.webContents.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url, { allowedProtocols: ['http:', 'https:', 'mailto:'] })
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
}

export function createMailView(module: MailModule = 'mail'): WebContentsView {
  registerMailIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  guardNavigation(view)
  if (module !== 'mail') initialModules.set(view.webContents.id, module)
  void view.webContents.loadURL(rendererUrl(runtime.rendererUrl, 'mail', { mode: 'tab' }))
  return view
}

/** `npm run dev -w @genoffice/mail`: the mail module in its own window */
export function startMailStandalone(): void {
  registerRendererScheme()
  void app.whenReady().then(() => {
    installRendererProtocol({ mail: join(__dirname, '../renderer') })
    registerMailIpc()
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      title: 'Suite Office Mail',
      webPreferences: {
        preload: runtime.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    void win.loadURL(rendererUrl(process.env.ELECTRON_RENDERER_URL, 'mail'))
  })
  app.on('window-all-closed', () => app.quit())
}
