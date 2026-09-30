import type { FileDialogRequest, MessageBoxRequest } from '../../shared/protocol'
import type { Conn } from '../hub'
import { rootConn } from './contents'
import { isQuitting } from './app'
import { tolerant } from './tolerant'

/**
 * Native dialogs become in-page dialogs drawn by the root page. A dialog
 * raised before any browser is attached waits for one; a dialog cut off by a
 * reload is shown again on the reloaded page.
 */

async function waitForRoot(): Promise<Conn> {
  for (;;) {
    const conn = await rootConn(60_000)
    if (conn) return conn
  }
}

async function ask<T>(kind: string, data: unknown, fallback: T): Promise<T> {
  for (let attempt = 0; attempt < 3 && !isQuitting(); attempt++) {
    const conn = await waitForRoot()
    try {
      return await conn.request<T>(kind, data)
    } catch {
      // the page went away mid-dialog; ask again on the next one
    }
  }
  return fallback
}

/** dialog.x(win, opts) and dialog.x(opts) */
function optionsArg<T>(a: unknown, b: unknown): T {
  const first = a as { webContents?: unknown } | undefined
  const looksLikeWindow = !!first && typeof first === 'object' && 'webContents' in first
  return ((looksLikeWindow ? b : a) ?? {}) as T
}

function stripAccessKeys(label: string): string {
  return label.replace(/&(&?)/g, (_m, amp: string) => amp)
}

interface MessageBoxOptions {
  type?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
  title?: string
  message: string
  detail?: string
  checkboxLabel?: string
  checkboxChecked?: boolean
  normalizeAccessKeys?: boolean
}

function toMessageBox(options: MessageBoxOptions): MessageBoxRequest {
  const buttons = (options.buttons?.length ? options.buttons : ['OK']).map((b) =>
    options.normalizeAccessKeys ? stripAccessKeys(b) : b,
  )
  let cancelId = options.cancelId
  if (cancelId === undefined) {
    const idx = buttons.findIndex((b) => /^(cancel|no|abbrechen|nein)$/i.test(b.trim()))
    cancelId = idx >= 0 ? idx : 0
  }
  return {
    type: options.type,
    title: options.title,
    message: String(options.message ?? ''),
    detail: options.detail,
    buttons,
    defaultId: options.defaultId,
    cancelId,
    checkboxLabel: options.checkboxLabel,
    checkboxChecked: options.checkboxChecked,
  }
}

interface OpenDialogOptions {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: { name: string; extensions: string[] }[]
  properties?: string[]
}

function fileRequest(mode: 'open' | 'save', options: OpenDialogOptions): FileDialogRequest {
  const props = new Set(options.properties ?? [])
  return {
    mode,
    title: options.title,
    buttonLabel: options.buttonLabel,
    defaultPath: options.defaultPath,
    filters: options.filters,
    directory: props.has('openDirectory') && !props.has('openFile'),
    multi: props.has('multiSelections'),
    showHidden: props.has('showHiddenFiles'),
    createDirectory: mode === 'save' || props.has('createDirectory'),
  }
}

export const dialog = tolerant(
  {
    async showMessageBox(a: unknown, b?: unknown) {
      const options = optionsArg<MessageBoxOptions>(a, b)
      const request = toMessageBox(options)
      return ask('message-box', request, {
        response: request.cancelId,
        checkboxChecked: !!request.checkboxChecked,
      })
    },
    showMessageBoxSync(a: unknown, b?: unknown): number {
      const request = toMessageBox(optionsArg<MessageBoxOptions>(a, b))
      void ask('message-box', request, null)
      return request.cancelId
    },
    showErrorBox(title: string, content: string): void {
      void ask(
        'message-box',
        toMessageBox({ type: 'error', title, message: title, detail: content }),
        null,
      )
    },
    async showOpenDialog(a: unknown, b?: unknown) {
      const request = fileRequest('open', optionsArg<OpenDialogOptions>(a, b))
      const result = await ask<{ canceled: boolean; filePaths: string[] }>('file-dialog', request, {
        canceled: true,
        filePaths: [],
      })
      return { canceled: result.canceled, filePaths: result.filePaths ?? [] }
    },
    showOpenDialogSync(): undefined {
      return undefined
    },
    async showSaveDialog(a: unknown, b?: unknown) {
      const request = fileRequest('save', optionsArg<OpenDialogOptions>(a, b))
      const result = await ask<{ canceled: boolean; filePaths: string[] }>('file-dialog', request, {
        canceled: true,
        filePaths: [],
      })
      const filePath = result.filePaths?.[0] ?? ''
      return { canceled: result.canceled || !filePath, filePath }
    },
    showSaveDialogSync(): undefined {
      return undefined
    },
    showCertificateTrustDialog(): Promise<void> {
      return Promise.resolve()
    },
  },
  'dialog',
)
