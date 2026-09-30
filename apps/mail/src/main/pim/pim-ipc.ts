import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  webContents,
  type IpcMainInvokeEvent,
} from 'electron'
import type { MailResult } from '../../shared/ipc'
import {
  PIM_CHANNELS,
  type AttendeeStatus,
  type ContactInput,
  type EventInput,
  type EventRange,
  type InvitationResponse,
  type PimChange,
  type PimSource,
  type PimSourceInput,
  type SourceKind,
} from '../../shared/pim'
import type { AccountStore, SecretBox } from '../accounts'
import { getMessage, sendCalendarMail, setInvitationHook, type Credentials } from '../mailbox'
import { CalendarService } from './calendar-service'
import { ContactsService } from './contacts-service'
import { guessDav } from './dav-presets'
import { forgetDav } from './dav'
import { applyPartstat, applyReply, buildReply, extractInvitation, stripMethod } from './itip'
import { Reminders } from './reminders'
import { SourceStore } from './store'

/**
 * Wires calendars, contacts and invitations to IPC: the services own the data,
 * this file owns the lifecycle — when sources sync, who hears about changes,
 * and how mail accounts lend their credentials and their SMTP to the calendar.
 */

export interface PimHost {
  accounts: () => AccountStore
  credentials: (accountId: string) => Credentials
  secretBox: () => SecretBox | null
  /** show the calendar (a reminder was clicked) */
  openCalendar: () => void
  /** the UI language, for reminder and reply texts */
  language: () => string
}

const SYNC_INTERVAL_MS = 10 * 60_000

let calendars: CalendarService | null = null
let contacts: ContactsService | null = null
let sourceStore: SourceStore | null = null
let reminders: Reminders | null = null
let registered = false
/** shown notifications, referenced until closed so their click handler survives GC */
const liveNotifications = new Set<Notification>()

const REMOTE: ReadonlySet<SourceKind> = new Set(['caldav', 'carddav', 'ics'])

function pimDir(): string {
  return join(app.getPath('userData'), 'pim')
}

async function result<T>(work: () => Promise<T> | T): Promise<MailResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function broadcast(change: PimChange): void {
  if (change.kind === 'calendar') reminders?.invalidate()
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send(PIM_CHANNELS.changed, change)
  }
}

/**
 * An imported .ics/.vcf file: UTF-8 when it is valid UTF-8, else Windows-1252
 * (older Outlook exports), so umlauts do not turn into U+FFFD.
 */
export function decodeImport(bytes: Uint8Array): string {
  const text = (() => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return new TextDecoder('windows-1252').decode(bytes)
    }
  })()
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function windowOf(e: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(e.sender) ?? undefined
}

const PARTSTAT: Record<InvitationResponse['answer'], AttendeeStatus> = {
  accepted: 'accepted',
  tentative: 'tentative',
  declined: 'declined',
}

export function registerPimIpc(host: PimHost): void {
  if (registered) return
  registered = true

  const identities = () =>
    host
      .accounts()
      .list()
      .map((a) => ({ accountId: a.id, name: a.name, email: a.email }))

  const store = (sourceStore ??= new SourceStore(pimDir, host.secretBox()))
  const cal = (calendars ??= new CalendarService({
    dir: pimDir,
    sources: store,
    localName: 'Auf diesem Computer',
    identities,
    sendItip: (fromAccountId, to, subject, text, ics, method) =>
      sendCalendarMail(host.credentials(fromAccountId), to, subject, text, ics, method),
  }))
  const con = (contacts ??= new ContactsService({
    dir: pimDir,
    sources: store,
    localName: 'Auf diesem Computer',
  }))

  // meeting messages: show the invitation, and quietly file answers to
  // meetings the user organized (Outlook's "tracking")
  setInvitationHook((parsed) => {
    const invitation = extractInvitation(parsed, (uid) => cal.findByUid(uid)?.calendarId)
    if (invitation?.method === 'REPLY' && invitation.existingEventId) {
      const calendarId = invitation.existingEventId
      const stored = cal.getRawIcs(calendarId, invitation.uid)
      const merged = stored ? applyReply(stored, invitation.ics) : null
      if (merged) {
        void cal
          .upsertIcs(calendarId, merged)
          .then(() => broadcast({ kind: 'calendar' }))
          .catch(() => undefined)
      }
    }
    return invitation
  })

  const serviceFor = (kind: SourceKind): 'calendar' | 'contacts' =>
    kind === 'carddav' ? 'contacts' : 'calendar'

  const syncOne = async (id: string): Promise<void> => {
    const source = store.get(id)
    if (!source || !REMOTE.has(source.kind)) return
    try {
      if (serviceFor(source.kind) === 'contacts') await con.syncSource(source)
      else await cal.syncSource(source)
      store.markSynced(id)
    } catch (err) {
      store.markSynced(id, err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      broadcast({ kind: serviceFor(source.kind) === 'contacts' ? 'contacts' : 'calendar' })
      broadcast({ kind: 'sources' })
    }
  }

  let syncing: Promise<void> | null = null
  const syncAll = (): Promise<void> => {
    syncing ??= (async () => {
      const errors: string[] = []
      for (const source of store.list()) {
        if (!REMOTE.has(source.kind)) continue
        await syncOne(source.id).catch((err: unknown) =>
          errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`),
        )
      }
      if (errors.length) throw new Error(errors.join('\n'))
    })().finally(() => {
      syncing = null
    })
    return syncing
  }

  const borrowed = (input: PimSourceInput): { user: string; password: string } | undefined => {
    if (!input.mailAccountId) return undefined
    const creds = host.credentials(input.mailAccountId)
    return { user: creds.account.user, password: creds.password }
  }

  const test = async (input: PimSourceInput): Promise<void> => {
    if (input.kind === 'local') return
    if (!input.url?.trim()) throw new Error('Bitte die Adresse des Servers bzw. Kalenders angeben.')
    const source = store.resolve(input, borrowed(input))
    const password = store.password(source)
    if (input.kind === 'carddav') await con.testSource(source, password)
    else await cal.testSource(source, password)
  }

  ipcMain.handle(PIM_CHANNELS.listSources, (): PimSource[] => {
    store.ensureLocal('Auf diesem Computer')
    return store.list().map(SourceStore.info)
  })

  ipcMain.handle(PIM_CHANNELS.guessDav, (_e, email: string) => guessDav(String(email ?? '')))

  ipcMain.handle(PIM_CHANNELS.testSource, (_e, input: PimSourceInput) => result(() => test(input)))

  ipcMain.handle(PIM_CHANNELS.saveSource, (_e, input: PimSourceInput) =>
    result(async () => {
      if (input.kind === 'local') throw new Error('Der lokale Speicher ist immer vorhanden.')
      await test(input)
      const source = store.save(store.resolve(input, borrowed(input)))
      if (!source.name) source.name = new URL(source.url ?? 'https://x').hostname
      store.save(source)
      forgetDav(source.id)
      cal.forgetSource(source.id)
      con.forgetSource(source.id)
      await syncOne(source.id).catch(() => undefined)
      return SourceStore.info(store.get(source.id) ?? source)
    }),
  )

  ipcMain.handle(PIM_CHANNELS.removeSource, (_e, id: string) => {
    const source = store.get(id)
    if (!source || source.kind === 'local') return
    store.remove(id)
    forgetDav(id)
    cal.forgetSource(id)
    con.forgetSource(id)
    broadcast({ kind: 'sources' })
    broadcast({ kind: serviceFor(source.kind) === 'contacts' ? 'contacts' : 'calendar' })
  })

  ipcMain.handle(PIM_CHANNELS.sync, (_e, sourceId?: string) =>
    result(() => (sourceId ? syncOne(sourceId) : syncAll())),
  )

  // ---- calendars ----

  ipcMain.handle(PIM_CHANNELS.listCalendars, () => cal.listCalendars())

  ipcMain.handle(
    PIM_CHANNELS.updateCalendar,
    (_e, id: string, patch: { color?: string; visible?: boolean; name?: string }) =>
      result(async () => {
        await cal.updateCalendar(id, patch)
        broadcast({ kind: 'calendar' })
      }),
  )

  ipcMain.handle(PIM_CHANNELS.createCalendar, (_e, sourceId: string, name: string, color: string) =>
    result(async () => {
      const created = await cal.createCalendar(sourceId, name, color)
      broadcast({ kind: 'calendar' })
      return created
    }),
  )

  ipcMain.handle(PIM_CHANNELS.listEvents, (_e, range: EventRange) =>
    result(() => cal.listEvents(range)),
  )

  ipcMain.handle(
    PIM_CHANNELS.getEvent,
    (_e, calendarId: string, uid: string, occurrenceStart?: string) =>
      result(() => cal.getEvent(calendarId, uid, occurrenceStart)),
  )

  // after a failed write too: a conflict (412) re-synced the calendar, and the
  // view should show what the server has now
  ipcMain.handle(PIM_CHANNELS.saveEvent, (_e, input: EventInput) =>
    result(() => cal.saveEvent(input)).finally(() => broadcast({ kind: 'calendar' })),
  )

  ipcMain.handle(
    PIM_CHANNELS.deleteEvent,
    (
      _e,
      calendarId: string,
      uid: string,
      scope?: 'occurrence' | 'series',
      occurrenceStart?: string,
    ) =>
      result(() => cal.deleteEvent(calendarId, uid, scope, occurrenceStart)).finally(() =>
        broadcast({ kind: 'calendar' }),
      ),
  )

  ipcMain.handle(PIM_CHANNELS.importIcs, (e, calendarId: string) =>
    result(async () => {
      const options = {
        properties: ['openFile' as const],
        filters: [{ name: 'iCalendar', extensions: ['ics', 'ical', 'ifb', 'icalendar'] }],
      }
      const win = windowOf(e)
      const picked = await (win
        ? dialog.showOpenDialog(win, options)
        : dialog.showOpenDialog(options))
      if (picked.canceled || !picked.filePaths[0]) return 0
      const count = await cal.importIcs(
        calendarId,
        decodeImport(await readFile(picked.filePaths[0])),
      )
      broadcast({ kind: 'calendar' })
      return count
    }),
  )

  ipcMain.handle(PIM_CHANNELS.exportIcs, (e, calendarId: string) =>
    result(async () => {
      const name = cal.listCalendars().find((c) => c.id === calendarId)?.name ?? 'Kalender'
      const options = {
        defaultPath: join(app.getPath('documents'), `${name.replace(/[\\/:*?"<>|]/g, '_')}.ics`),
        filters: [{ name: 'iCalendar', extensions: ['ics'] }],
      }
      const win = windowOf(e)
      const picked = await (win
        ? dialog.showSaveDialog(win, options)
        : dialog.showSaveDialog(options))
      if (picked.canceled || !picked.filePath) return ''
      await writeFile(picked.filePath, await cal.exportIcs(calendarId), 'utf8')
      return picked.filePath
    }),
  )

  // ---- contacts ----

  ipcMain.handle(PIM_CHANNELS.listAddressBooks, () => con.listAddressBooks())

  ipcMain.handle(PIM_CHANNELS.listContacts, (_e, query?: string) =>
    result(() => con.listContacts(query)),
  )

  ipcMain.handle(PIM_CHANNELS.saveContact, (_e, input: ContactInput) =>
    result(() => con.saveContact(input)).finally(() => broadcast({ kind: 'contacts' })),
  )

  ipcMain.handle(PIM_CHANNELS.deleteContact, (_e, addressBookId: string, uid: string) =>
    result(() => con.deleteContact(addressBookId, uid)).finally(() =>
      broadcast({ kind: 'contacts' }),
    ),
  )

  ipcMain.handle(PIM_CHANNELS.importVcf, (e, addressBookId: string) =>
    result(async () => {
      const options = {
        properties: ['openFile' as const],
        filters: [{ name: 'vCard', extensions: ['vcf', 'vcard'] }],
      }
      const win = windowOf(e)
      const picked = await (win
        ? dialog.showOpenDialog(win, options)
        : dialog.showOpenDialog(options))
      if (picked.canceled || !picked.filePaths[0]) return 0
      const count = await con.importVcf(
        addressBookId,
        decodeImport(await readFile(picked.filePaths[0])),
      )
      broadcast({ kind: 'contacts' })
      return count
    }),
  )

  ipcMain.handle(PIM_CHANNELS.exportVcf, (e, addressBookId: string) =>
    result(async () => {
      const options = {
        defaultPath: join(app.getPath('documents'), 'Kontakte.vcf'),
        filters: [{ name: 'vCard', extensions: ['vcf'] }],
      }
      const win = windowOf(e)
      const picked = await (win
        ? dialog.showSaveDialog(win, options)
        : dialog.showSaveDialog(options))
      if (picked.canceled || !picked.filePath) return ''
      await writeFile(picked.filePath, await con.exportVcf(addressBookId), 'utf8')
      return picked.filePath
    }),
  )

  ipcMain.handle(PIM_CHANNELS.suggestAddresses, (_e, query: string, limit?: number) =>
    con.suggest(String(query ?? ''), limit),
  )

  ipcMain.handle(
    PIM_CHANNELS.rememberRecipients,
    (_e, list: Array<{ name: string; email: string }>) => {
      if (Array.isArray(list)) con.rememberRecipients(list)
    },
  )

  // ---- invitations ----

  ipcMain.handle(PIM_CHANNELS.respondInvitation, (_e, response: InvitationResponse) =>
    result(async () => {
      const creds = host.credentials(response.accountId)
      const message = await getMessage(creds, response.folder, response.uid)
      const invitation = message.invitation
      if (!invitation) throw new Error('Diese E-Mail enthält keine Einladung.')
      const me = { name: creds.account.name, email: creds.account.email }
      if (response.answer === 'declined') {
        const existing = cal.findByUid(invitation.uid)
        if (existing) await cal.removeByUid(existing.calendarId, invitation.uid)
      } else {
        const calendarId =
          response.calendarId ??
          cal.findByUid(invitation.uid)?.calendarId ??
          cal.listCalendars().find((c) => !c.readOnly)?.id
        if (!calendarId) throw new Error('Es gibt keinen beschreibbaren Kalender.')
        const ics = applyPartstat(stripMethod(invitation.ics), me.email, PARTSTAT[response.answer])
        // a newer version of the meeting replaces the stored one wherever it lives
        const existing = cal.findByUid(invitation.uid)
        if (existing && existing.calendarId !== calendarId) {
          await cal.removeByUid(existing.calendarId, invitation.uid)
        }
        await cal.upsertIcs(calendarId, ics)
      }
      broadcast({ kind: 'calendar' })
      const organizer = invitation.organizer?.email
      if (
        response.notifyOrganizer !== false &&
        invitation.method === 'REQUEST' &&
        organizer &&
        organizer.toLowerCase() !== me.email.toLowerCase()
      ) {
        const lang = (response.lang ?? host.language()).toLowerCase().startsWith('de') ? 'de' : 'en'
        const reply = buildReply(invitation, me, response.answer, lang)
        await sendCalendarMail(creds, [organizer], reply.subject, reply.text, reply.ics, 'REPLY')
      }
    }),
  )

  reminders = new Reminders({
    listEvents: (from, to) => cal.listEvents({ from: from.toISOString(), to: to.toISOString() }),
    dir: pimDir,
    notify: (title, body, onClick) => {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body })
      liveNotifications.add(notification)
      const release = (): void => void liveNotifications.delete(notification)
      notification.on('click', () => {
        release()
        onClick()
      })
      notification.on('close', release)
      notification.show()
    },
    openCalendar: host.openCalendar,
    lang: host.language,
  })

  // remote sources: once shortly after start, then every few minutes
  setTimeout(() => {
    void syncAll().catch(() => undefined)
    reminders?.start()
  }, 5_000)
  setInterval(() => void syncAll().catch(() => undefined), SYNC_INTERVAL_MS).unref?.()
}
