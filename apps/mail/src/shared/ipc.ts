import type { AiSettings, AiStreamChunk, AiStreamRequest } from '@genoffice/ai-provider'
import type { Invitation } from './pim'

/** IPC surface of the mail module (shell tab `mail`). */
export const MAIL_CHANNELS = {
  listAccounts: 'mail:list-accounts',
  saveAccount: 'mail:save-account',
  removeAccount: 'mail:remove-account',
  testAccount: 'mail:test-account',
  guessServers: 'mail:guess-servers',
  listFolders: 'mail:list-folders',
  listMessages: 'mail:list-messages',
  getMessage: 'mail:get-message',
  setFlags: 'mail:set-flags',
  moveMessages: 'mail:move-messages',
  deleteMessages: 'mail:delete-messages',
  saveAttachment: 'mail:save-attachment',
  pickAttachments: 'mail:pick-attachments',
  send: 'mail:send',
  initialModule: 'mail:initial-module',
  showModule: 'mail:show-module',
} as const

/** the three parts of the mail tab, like Outlook's module bar */
export type MailModule = 'mail' | 'calendar' | 'contacts'

export type UiTheme = 'system' | 'light' | 'dark'

export interface ServerSettings {
  host: string
  port: number
  /** implicit TLS (993 / 465); false means STARTTLS on the plain port */
  secure: boolean
}

/** an account as the renderer sees it — the password never travels back */
export interface MailAccountInfo {
  id: string
  name: string
  email: string
  user: string
  imap: ServerSettings
  smtp: ServerSettings
  hasPassword: boolean
}

export interface MailAccountInput {
  id?: string
  name: string
  email: string
  user: string
  /** empty keeps the stored password when editing */
  password: string
  imap: ServerSettings
  smtp: ServerSettings
}

export interface MailFolder {
  path: string
  name: string
  /** IMAP special-use flag: \Inbox, \Sent, \Drafts, \Trash, \Junk, \Archive, \Flagged, \All */
  specialUse?: string
  unseen?: number
  depth: number
}

export interface MailAddress {
  name: string
  address: string
}

export interface MailSummary {
  uid: number
  subject: string
  from: MailAddress[]
  to: MailAddress[]
  date: string
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
  size: number
}

export interface MailPage {
  total: number
  messages: MailSummary[]
}

export interface MailAttachmentInfo {
  index: number
  filename: string
  contentType: string
  size: number
}

export interface MailMessage {
  uid: number
  folder: string
  subject: string
  from: MailAddress[]
  to: MailAddress[]
  cc: MailAddress[]
  replyTo: MailAddress[]
  date: string
  /** the mail's HTML with inline cid: images embedded; shown only in a sandboxed,
   * script-free frame. Empty for text-only mail */
  html: string
  text: string
  messageId?: string
  references: string[]
  attachments: MailAttachmentInfo[]
  /** the HTML references http(s) images that stay blocked until the user allows them */
  hasRemoteContent: boolean
  /** a meeting invitation (or answer, or cancellation) carried as text/calendar */
  invitation?: Invitation
}

export interface OutgoingMail {
  accountId: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  text: string
  inReplyTo?: string
  references?: string[]
  /** absolute paths picked through pickAttachments */
  attachments?: string[]
  /** the message this replies to, flagged \Answered once the reply is out */
  answering?: { folder: string; uid: number }
}

export interface MailResult<T = undefined> {
  ok: boolean
  value?: T
  error?: string
}

export interface MailApi {
  getLanguage(): Promise<string>
  onLanguageChanged(handler: (lang: string) => void): () => void
  getTheme(): Promise<UiTheme>
  onThemeChanged(handler: (theme: UiTheme) => void): () => void

  listAccounts(): Promise<MailAccountInfo[]>
  saveAccount(input: MailAccountInput): Promise<MailResult<MailAccountInfo>>
  removeAccount(id: string): Promise<void>
  testAccount(input: MailAccountInput): Promise<MailResult>
  guessServers(
    email: string,
  ): Promise<{ imap: ServerSettings; smtp: ServerSettings; note?: string } | null>

  listFolders(accountId: string): Promise<MailResult<MailFolder[]>>
  listMessages(
    accountId: string,
    folder: string,
    options: { page: number; pageSize: number; query?: string },
  ): Promise<MailResult<MailPage>>
  getMessage(accountId: string, folder: string, uid: number): Promise<MailResult<MailMessage>>
  setFlags(
    accountId: string,
    folder: string,
    uids: number[],
    flag: 'seen' | 'flagged',
    on: boolean,
  ): Promise<MailResult>
  moveMessages(
    accountId: string,
    folder: string,
    uids: number[],
    target: string,
  ): Promise<MailResult>
  deleteMessages(accountId: string, folder: string, uids: number[]): Promise<MailResult>
  saveAttachment(
    accountId: string,
    folder: string,
    uid: number,
    index: number,
  ): Promise<MailResult<string>>
  pickAttachments(): Promise<string[]>
  send(mail: OutgoingMail): Promise<MailResult>

  /** which part the tab was opened for (home screen cards) */
  initialModule(): Promise<MailModule>
  onShowModule(handler: (module: MailModule) => void): () => void

  getAiSettings(): Promise<AiSettings>
  aiStream(request: AiStreamRequest): Promise<void>
  aiStreamCancel(requestId: string): Promise<void>
  onAiStream(handler: (chunk: AiStreamChunk) => void): () => void
}
