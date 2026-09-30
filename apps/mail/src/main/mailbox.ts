import {
  ImapFlow,
  type FetchMessageObject,
  type ListResponse,
  type MessageAddressObject,
} from 'imapflow'
import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from 'mailparser'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import { basename } from 'node:path'
import type { Invitation } from '../shared/pim'
import type {
  MailAddress,
  MailFolder,
  MailMessage,
  MailPage,
  MailSummary,
  OutgoingMail,
  ServerSettings,
} from '../shared/ipc'
import type { StoredAccount } from './accounts'

/**
 * One live IMAP connection per account, opened on first use and dropped when
 * the server closes it; every mailbox operation holds that mailbox's lock.
 * Nothing is cached on disk: the server is the source of truth, as in any
 * IMAP client that is not trying to be a sync engine.
 */

export interface Credentials {
  account: StoredAccount
  password: string
}

const clients = new Map<string, Promise<ImapFlow>>()
const IMAP_TIMEOUT_MS = 30_000

function imapOptions(server: ServerSettings, user: string, pass: string) {
  return {
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: { user, pass },
    logger: false as const,
    connectionTimeout: IMAP_TIMEOUT_MS,
    greetingTimeout: IMAP_TIMEOUT_MS,
    socketTimeout: 5 * 60_000,
    // STARTTLS on plain ports; local bridges (Proton) use self-signed certs
    tls: { rejectUnauthorized: !['127.0.0.1', 'localhost'].includes(server.host) },
  }
}

async function client({ account, password }: Credentials): Promise<ImapFlow> {
  const existing = clients.get(account.id)
  if (existing) {
    const c = await existing.catch(() => null)
    if (c?.usable) return c
    clients.delete(account.id)
  }
  const pending = (async () => {
    const c = new ImapFlow(imapOptions(account.imap, account.user, password))
    c.on('error', () => clients.delete(account.id))
    c.on('close', () => clients.delete(account.id))
    await c.connect()
    return c
  })()
  clients.set(account.id, pending)
  try {
    return await pending
  } catch (err) {
    clients.delete(account.id)
    throw friendlyError(err)
  }
}

export function dropClient(accountId: string): void {
  const pending = clients.get(accountId)
  clients.delete(accountId)
  void pending?.then((c) => c.logout()).catch(() => undefined)
}

export async function closeAll(): Promise<void> {
  const all = [...clients.values()]
  clients.clear()
  await Promise.all(all.map((p) => p.then((c) => c.logout()).catch(() => undefined)))
}

/** turn protocol errors into something a person can act on */
export function friendlyError(err: unknown): Error {
  const e = err as {
    authenticationFailed?: boolean
    code?: string
    responseText?: string
    message?: string
  }
  if (e?.authenticationFailed || /auth|credentials|login/i.test(e?.responseText ?? '')) {
    return new Error(
      'Anmeldung fehlgeschlagen. Stimmen Benutzername und Passwort? Viele Anbieter verlangen ein App-Passwort.',
    )
  }
  if (e?.code === 'ENOTFOUND')
    return new Error('Server nicht gefunden. Bitte den Servernamen prüfen.')
  if (e?.code === 'ECONNREFUSED')
    return new Error('Der Server lehnt die Verbindung ab. Port und Verschlüsselung prüfen.')
  if (e?.code === 'ETIMEDOUT' || e?.code === 'NoConnection') {
    return new Error('Keine Verbindung zum Server (Zeitüberschreitung).')
  }
  return err instanceof Error ? err : new Error(String(err))
}

async function withMailbox<T>(
  creds: Credentials,
  path: string,
  work: (c: ImapFlow) => Promise<T>,
): Promise<T> {
  const c = await client(creds)
  const lock = await c.getMailboxLock(path)
  try {
    return await work(c)
  } catch (err) {
    throw friendlyError(err)
  } finally {
    lock.release()
  }
}

// ---- folders ----

const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash']

export async function listFolders(creds: Credentials): Promise<MailFolder[]> {
  const c = await client(creds)
  let boxes: ListResponse[]
  try {
    boxes = await c.list({ statusQuery: { unseen: true } })
  } catch (err) {
    throw friendlyError(err)
  }
  const folders = boxes
    .filter((b) => !b.flags.has('\\Noselect') && !b.flags.has('\\NonExistent'))
    .map((b): MailFolder => ({
      path: b.path,
      name: b.path.toUpperCase() === 'INBOX' ? 'Posteingang' : b.name,
      specialUse: b.path.toUpperCase() === 'INBOX' ? '\\Inbox' : b.specialUse,
      unseen: b.status?.unseen,
      depth: b.delimiter ? b.path.split(b.delimiter).length - 1 : 0,
    }))
  const rank = (f: MailFolder): number => {
    const i = f.specialUse ? SPECIAL_ORDER.indexOf(f.specialUse) : -1
    return i < 0 ? SPECIAL_ORDER.length : i
  }
  return folders.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
}

async function specialFolder(creds: Credentials, use: string): Promise<string | null> {
  const c = await client(creds)
  const boxes = await c.list()
  return boxes.find((b) => b.specialUse === use)?.path ?? null
}

// ---- message lists ----

function addresses(list: MessageAddressObject[] | undefined): MailAddress[] {
  return (list ?? []).map((a) => ({ name: a.name ?? '', address: a.address ?? '' }))
}

function hasAttachment(node: FetchMessageObject['bodyStructure']): boolean {
  if (!node) return false
  if (node.disposition === 'attachment') return true
  return (node.childNodes ?? []).some(hasAttachment)
}

function summary(m: FetchMessageObject): MailSummary {
  const flags = m.flags ?? new Set<string>()
  return {
    uid: m.uid,
    subject: m.envelope?.subject ?? '',
    from: addresses(m.envelope?.from),
    to: addresses(m.envelope?.to),
    date: (m.envelope?.date ?? m.internalDate ?? new Date(0)).toString(),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: hasAttachment(m.bodyStructure),
    size: m.size ?? 0,
  }
}

const LIST_FIELDS = {
  uid: true,
  envelope: true,
  flags: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
}

export async function listMessages(
  creds: Credentials,
  path: string,
  options: { page: number; pageSize: number; query?: string },
): Promise<MailPage> {
  const pageSize = Math.max(1, Math.min(200, options.pageSize))
  return withMailbox(creds, path, async (c) => {
    const box = c.mailbox
    const exists = box && typeof box === 'object' ? box.exists : 0
    const messages: MailSummary[] = []
    const query = options.query?.trim()
    if (query) {
      const found = await c.search(
        { or: [{ subject: query }, { from: query }, { to: query }, { body: query }] },
        { uid: true },
      )
      const uids = (found || []).sort((a, b) => b - a)
      const slice = uids.slice(options.page * pageSize, (options.page + 1) * pageSize)
      if (slice.length) {
        for await (const m of c.fetch(slice.join(','), LIST_FIELDS, { uid: true }))
          messages.push(summary(m))
      }
      messages.sort((a, b) => b.uid - a.uid)
      return { total: uids.length, messages }
    }
    if (!exists) return { total: 0, messages }
    const end = exists - options.page * pageSize
    if (end < 1) return { total: exists, messages }
    const start = Math.max(1, end - pageSize + 1)
    for await (const m of c.fetch(`${start}:${end}`, LIST_FIELDS)) messages.push(summary(m))
    messages.sort((a, b) => b.uid - a.uid)
    return { total: exists, messages }
  })
}

// ---- one message ----

function parsedAddresses(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list.flatMap((a) => a.value.map((v) => ({ name: v.name ?? '', address: v.address ?? '' })))
}

const REMOTE_RE =
  /\b(?:src|background)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i

/** inline cid: pictures become data: URLs so the sandboxed frame can show them */
export function embedInlineImages(html: string, attachments: Attachment[]): string {
  if (!html.includes('cid:')) return html
  const byCid = new Map<string, Attachment>()
  for (const a of attachments) {
    if (a.contentId) byCid.set(a.contentId.replace(/^<|>$/g, '').toLowerCase(), a)
  }
  return html.replace(/cid:([^"'\s)>]+)/gi, (whole, id: string) => {
    const att = byCid.get(decodeURIComponent(id).toLowerCase())
    if (!att) return whole
    return `data:${att.contentType};base64,${att.content.toString('base64')}`
  })
}

type InvitationHook = (parsed: ParsedMail) => Invitation | undefined
let invitationHook: InvitationHook | null = null

/** the calendar side reads meeting invitations out of opened messages */
export function setInvitationHook(hook: InvitationHook | null): void {
  invitationHook = hook
}

/** the last opened message's parts, for saving an attachment without refetching */
const recentParsed = new Map<string, ParsedMail>()
const parsedKey = (accountId: string, path: string, uid: number): string =>
  `${accountId}\n${path}\n${uid}`

async function fetchParsed(
  creds: Credentials,
  path: string,
  uid: number,
  markSeen: boolean,
): Promise<ParsedMail> {
  const key = parsedKey(creds.account.id, path, uid)
  const cached = recentParsed.get(key)
  if (cached && !markSeen) return cached
  return withMailbox(creds, path, async (c) => {
    const msg = await c.fetchOne(String(uid), { source: true, flags: true }, { uid: true })
    if (!msg || !msg.source)
      throw new Error('Die Nachricht wurde nicht gefunden (evtl. verschoben oder gelöscht).')
    const parsed = await simpleParser(msg.source)
    if (markSeen && !msg.flags?.has('\\Seen')) {
      await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => undefined)
    }
    recentParsed.set(key, parsed)
    while (recentParsed.size > 20) recentParsed.delete(recentParsed.keys().next().value!)
    return parsed
  })
}

export async function getMessage(
  creds: Credentials,
  path: string,
  uid: number,
): Promise<MailMessage> {
  const parsed = await fetchParsed(creds, path, uid, true)
  let invitation: Invitation | undefined
  try {
    invitation = invitationHook?.(parsed)
  } catch {
    // a broken calendar part must not keep the mail from opening
    invitation = undefined
  }
  const listed = parsed.attachments.filter(
    (a) =>
      (a.contentDisposition !== 'inline' || !a.contentId) &&
      !(invitation && /^(text\/calendar|application\/ics)$/i.test(a.contentType)),
  )
  const html =
    typeof parsed.html === 'string' ? embedInlineImages(parsed.html, parsed.attachments) : ''
  const refs = parsed.references
  return {
    uid,
    folder: path,
    subject: parsed.subject ?? '',
    from: parsedAddresses(parsed.from),
    to: parsedAddresses(parsed.to),
    cc: parsedAddresses(parsed.cc),
    replyTo: parsedAddresses(parsed.replyTo),
    date: (parsed.date ?? new Date()).toISOString(),
    html,
    text: parsed.text ?? '',
    messageId: parsed.messageId,
    references: Array.isArray(refs) ? refs : refs ? [refs] : [],
    attachments: listed.map((a) => ({
      index: parsed.attachments.indexOf(a),
      filename: a.filename || 'anhang',
      contentType: a.contentType,
      size: a.size,
    })),
    hasRemoteContent: REMOTE_RE.test(html),
    ...(invitation ? { invitation } : {}),
  }
}

export async function attachmentContent(
  creds: Credentials,
  path: string,
  uid: number,
  index: number,
): Promise<{ filename: string; content: Buffer }> {
  const parsed = await fetchParsed(creds, path, uid, false)
  const att = parsed.attachments[index]
  if (!att) throw new Error('Anhang nicht gefunden.')
  return { filename: basename(att.filename || `anhang-${index + 1}`), content: att.content }
}

// ---- changes ----

export async function setFlags(
  creds: Credentials,
  path: string,
  uids: number[],
  flag: 'seen' | 'flagged',
  on: boolean,
): Promise<void> {
  if (!uids.length) return
  const name = flag === 'seen' ? '\\Seen' : '\\Flagged'
  await withMailbox(creds, path, async (c) => {
    if (on) await c.messageFlagsAdd(uids.join(','), [name], { uid: true })
    else await c.messageFlagsRemove(uids.join(','), [name], { uid: true })
  })
}

export async function moveMessages(
  creds: Credentials,
  path: string,
  uids: number[],
  target: string,
): Promise<void> {
  if (!uids.length || target === path) return
  await withMailbox(creds, path, (c) =>
    c.messageMove(uids.join(','), target, { uid: true }).then(() => undefined),
  )
}

/** to the trash folder; messages already in the trash are removed for good */
export async function deleteMessages(
  creds: Credentials,
  path: string,
  uids: number[],
): Promise<void> {
  if (!uids.length) return
  const trash = await specialFolder(creds, '\\Trash')
  if (trash && trash !== path) {
    await moveMessages(creds, path, uids, trash)
    return
  }
  await withMailbox(creds, path, (c) =>
    c.messageDelete(uids.join(','), { uid: true }).then(() => undefined),
  )
}

// ---- sending ----

function transport(account: StoredAccount, password: string) {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.user, pass: password },
    connectionTimeout: IMAP_TIMEOUT_MS,
    tls: { rejectUnauthorized: !['127.0.0.1', 'localhost'].includes(account.smtp.host) },
  })
}

function sender(account: StoredAccount): string {
  const name = account.name && account.name !== account.email ? account.name.replace(/"/g, '') : ''
  return name ? `"${name}" <${account.email}>` : account.email
}

/** providers that file sent mail themselves; appending would duplicate it */
const SERVER_SAVES_SENT = /(^|\.)(gmail\.com|googlemail\.com|office365\.com|outlook\.com)$/i

export async function sendMail(creds: Credentials, mail: OutgoingMail): Promise<void> {
  const message = {
    from: sender(creds.account),
    to: mail.to,
    cc: mail.cc || undefined,
    bcc: mail.bcc || undefined,
    subject: mail.subject,
    text: mail.text,
    inReplyTo: mail.inReplyTo,
    references: mail.references?.length ? mail.references : undefined,
    attachments: (mail.attachments ?? []).map((p) => ({ path: p, filename: basename(p) })),
  }
  try {
    await transport(creds.account, creds.password).sendMail(message)
  } catch (err) {
    throw friendlyError(err)
  }
  await keepSentCopy(creds, message)
}

type ComposerOptions = ConstructorParameters<typeof MailComposer>[0]

/** keep a copy in "Sent", like every desktop client does */
async function keepSentCopy(creds: Credentials, message: ComposerOptions): Promise<void> {
  if (SERVER_SAVES_SENT.test(creds.account.smtp.host)) return
  try {
    const sent = await specialFolder(creds, '\\Sent')
    if (!sent) return
    const raw = await new MailComposer({ ...message, bcc: undefined }).compile().build()
    const c = await client(creds)
    await c.append(sent, raw, ['\\Seen'])
  } catch {
    // the mail went out; a missing copy is not worth an error
  }
}

/**
 * A meeting message (iTIP): the calendar object travels as a text/calendar
 * alternative with its METHOD, which is what Outlook, Google and Apple look
 * for to show Accept/Decline buttons.
 */
export async function sendCalendarMail(
  creds: Credentials,
  to: string[],
  subject: string,
  text: string,
  ics: string,
  method: 'REQUEST' | 'CANCEL' | 'REPLY',
): Promise<void> {
  if (!to.length) return
  const message = {
    from: sender(creds.account),
    to,
    subject,
    text,
    icalEvent: { method, content: ics, filename: method === 'REPLY' ? 'reply.ics' : 'invite.ics' },
  }
  try {
    await transport(creds.account, creds.password).sendMail(message)
  } catch (err) {
    throw friendlyError(err)
  }
  await keepSentCopy(creds, message)
}

export async function markAnswered(creds: Credentials, path: string, uid: number): Promise<void> {
  await withMailbox(creds, path, (c) =>
    c.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true }).then(() => undefined),
  ).catch(() => undefined)
}

/** log in to both servers without keeping the connections */
export async function testAccount(account: StoredAccount, password: string): Promise<void> {
  const imap = new ImapFlow(imapOptions(account.imap, account.user, password))
  try {
    await imap.connect()
  } catch (err) {
    throw new Error(`IMAP: ${friendlyError(err).message}`, { cause: err })
  } finally {
    await imap.logout().catch(() => undefined)
  }
  try {
    await transport(account, password).verify()
  } catch (err) {
    throw new Error(`SMTP: ${friendlyError(err).message}`, { cause: err })
  }
}
