import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.TZ = 'Europe/Berlin'

/** an in-memory CalDAV server behind the tsdav client surface the service uses */
class FakeDav {
  calendars: Array<{
    url: string
    displayName: string
    ctag: string
    components: string[]
    color?: string
    privileges?: string[]
    objects: Map<string, { data: string; etag: string }>
  }> = []
  calls: string[] = []
  private n = 0

  private cal(url: string) {
    const found = this.calendars.find(
      (c) => c.url === url || new URL(url).pathname === new URL(c.url).pathname,
    )
    if (!found) throw new Error(`no calendar ${url}`)
    return found
  }

  private owner(objectUrl: string) {
    const path = new URL(objectUrl, 'https://dav.example.org').pathname
    const cal = this.calendars.find((c) => path.startsWith(new URL(c.url).pathname))
    if (!cal) throw new Error(`no calendar for ${objectUrl}`)
    return { cal, path }
  }

  bump(url: string): void {
    const cal = this.cal(url)
    cal.ctag = `ctag-${++this.n}`
  }

  put(calUrl: string, name: string, data: string): void {
    const cal = this.cal(calUrl)
    cal.objects.set(new URL(name, calUrl).pathname, { data, etag: `"e${++this.n}"` })
    this.bump(calUrl)
  }

  fetchCalendars = vi.fn(async () =>
    this.calendars.map((c) => ({
      url: c.url,
      displayName: c.displayName,
      ctag: c.ctag,
      components: c.components,
      calendarColor: c.color,
      ...(c.privileges
        ? {
            projectedProps: {
              currentUserPrivilegeSet: { privilege: c.privileges.map((p) => ({ [p]: {} })) },
            },
          }
        : {}),
    })),
  )

  calendarQuery = vi.fn(async ({ url }: { url: string }) => {
    this.calls.push(`query ${new URL(url).pathname}`)
    return [...this.cal(url).objects].map(([href, o]) => ({
      href,
      ok: true,
      status: 207,
      statusText: 'Multi-Status',
      props: { getetag: o.etag },
    }))
  })

  fetchCalendarObjects = vi.fn(
    async ({ calendar, objectUrls }: { calendar: { url: string }; objectUrls: string[] }) => {
      this.calls.push(`multiget ${objectUrls.length}`)
      const cal = this.cal(calendar.url)
      return objectUrls
        .map((u) => new URL(u, calendar.url))
        .filter((u) => cal.objects.has(u.pathname))
        .map((u) => ({
          url: u.href,
          etag: cal.objects.get(u.pathname)!.etag,
          data: cal.objects.get(u.pathname)!.data,
        }))
    },
  )

  createCalendarObject = vi.fn(
    async ({
      calendar,
      iCalString,
      filename,
    }: {
      calendar: { url: string }
      iCalString: string
      filename: string
    }) => {
      const cal = this.cal(calendar.url)
      const path = new URL(filename, calendar.url).pathname
      this.calls.push(`create ${filename}`)
      if (cal.objects.has(path)) return new Response(null, { status: 412 })
      const etag = `"e${++this.n}"`
      cal.objects.set(path, { data: iCalString, etag })
      this.bump(cal.url)
      return new Response(null, { status: 201, headers: { etag } })
    },
  )

  updateCalendarObject = vi.fn(
    async ({
      calendarObject,
    }: {
      calendarObject: { url: string; data: string; etag?: string }
    }) => {
      const { cal, path } = this.owner(calendarObject.url)
      const current = cal.objects.get(path)
      this.calls.push(`update ${path}`)
      if (!current) return new Response(null, { status: 404 })
      if (calendarObject.etag && calendarObject.etag !== current.etag)
        return new Response(null, { status: 412 })
      const etag = `"e${++this.n}"`
      cal.objects.set(path, { data: calendarObject.data, etag })
      this.bump(cal.url)
      return new Response(null, { status: 204, headers: { etag } })
    },
  )

  deleteCalendarObject = vi.fn(
    async ({ calendarObject }: { calendarObject: { url: string; etag?: string } }) => {
      const { cal, path } = this.owner(calendarObject.url)
      const current = cal.objects.get(path)
      this.calls.push(`delete ${path}`)
      if (!current) return new Response(null, { status: 404 })
      if (calendarObject.etag && calendarObject.etag !== current.etag)
        return new Response(null, { status: 412 })
      cal.objects.delete(path)
      this.bump(cal.url)
      return new Response(null, { status: 204 })
    },
  )

  makeCalendar = vi.fn(async ({ url, props }: { url: string; props: Record<string, unknown> }) => {
    this.calendars.push({
      url,
      displayName: String(props['d:displayname']),
      ctag: `ctag-${++this.n}`,
      components: ['VEVENT'],
      objects: new Map(),
    })
    return [{ ok: true, status: 201, statusText: 'Created' }]
  })

  createAccount = vi.fn(async () => ({ homeUrl: 'https://dav.example.org/calendars/benni/' }))
}

const dav = vi.hoisted(() => ({ client: null as unknown, feed: '' }))

vi.mock('../src/main/pim/dav', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/pim/dav')>()
  return {
    ...actual,
    connectDav: vi.fn(async () => dav.client),
    forgetDav: vi.fn(),
    fetchIcs: vi.fn(async () => {
      if (!dav.feed) throw Object.assign(new Error('HTTP 404'), { status: 404 })
      return dav.feed
    }),
  }
})

const {
  CalendarService,
  collectionKey,
  diffObjects,
  normalizeColor,
  objectFilename,
  planCalendarSync,
  prepareStoredIcs,
  privilegesReadOnly,
  LOCAL_DEFAULT_ID,
} = await import('../src/main/pim/calendar-service')
const { SourceStore } = await import('../src/main/pim/store')
const { parseIcs } = await import('../src/main/pim/ics')

type Service = InstanceType<typeof CalendarService>

const ME = { accountId: 'acc-1', name: 'Benni Fischer', email: 'benni@example.org' }

let dir: string
let sources: InstanceType<typeof SourceStore>
let sendItip: ReturnType<typeof vi.fn>
let service: Service

function makeService(): Service {
  return new CalendarService({
    dir: () => dir,
    sources,
    localName: 'Kalender',
    identities: () => [ME],
    sendItip: sendItip as never,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'suite-cal-'))
  sources = new SourceStore(() => dir, null)
  sendItip = vi.fn(async () => undefined)
  service = makeService()
  dav.client = null
  dav.feed = ''
})

afterEach(() => {
  vi.clearAllMocks()
})

const W = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h, mi)).toISOString()

describe('local calendars', () => {
  it('starts with one local calendar and keeps user settings', async () => {
    const [cal] = service.listCalendars()
    expect(cal).toEqual({
      id: LOCAL_DEFAULT_ID,
      sourceId: 'local',
      name: 'Kalender',
      color: '#0f6cbd',
      visible: true,
      readOnly: false,
    })
    const work = await service.createCalendar('local', 'Arbeit', '#C4314B')
    expect(work.color).toBe('#c4314b')
    await service.updateCalendar(LOCAL_DEFAULT_ID, {
      color: '#13a10e',
      visible: false,
      name: 'Privat',
    })
    const fresh = makeService().listCalendars()
    expect(fresh.map((c) => [c.name, c.color, c.visible])).toEqual([
      ['Privat', '#13a10e', false],
      ['Arbeit', '#c4314b', true],
    ])
    await expect(service.updateCalendar('nope', { visible: true })).rejects.toThrow(
      'nicht gefunden',
    )
  })

  it('creates, lists, edits and deletes a timed event', async () => {
    const saved = await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      title: 'Zahnarzt',
      location: 'Praxis',
      start: W(2026, 10, 5, 7),
      end: W(2026, 10, 5, 8),
      allDay: false,
      reminders: [30],
      timezone: 'Europe/Berlin',
    })
    expect(saved.uid).toMatch(/@suite-office$/)
    expect(saved.start).toBe('2026-10-05T07:00:00.000Z')
    expect(saved.timezone).toBe('Europe/Berlin')
    expect(saved.recurring).toBe(false)
    expect(saved.id).toBe(`${LOCAL_DEFAULT_ID}|${saved.uid}|2026-10-05T07:00:00.000Z`)

    const raw = service.getRawIcs(LOCAL_DEFAULT_ID, saved.uid)!
    expect(raw).toContain('DTSTART;TZID=Europe/Berlin:20261005T090000')
    expect(raw).toContain('BEGIN:VTIMEZONE')
    expect(raw).toContain('TRIGGER:-PT30M')

    const listed = await service.listEvents({ from: W(2026, 10, 1, 0), to: W(2026, 11, 1, 0) })
    expect(listed.map((e) => [e.title, e.location, e.reminders])).toEqual([
      ['Zahnarzt', 'Praxis', [30]],
    ])
    expect(await service.listEvents({ from: W(2026, 11, 1, 0), to: W(2026, 12, 1, 0) })).toEqual([])

    const moved = await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      uid: saved.uid,
      title: 'Zahnarzt (verschoben)',
      start: W(2026, 10, 6, 12),
      end: W(2026, 10, 6, 13),
      allDay: false,
    })
    expect(moved.start).toBe('2026-10-06T12:00:00.000Z')
    expect(moved.location).toBe('Praxis')
    expect(moved.reminders).toEqual([30])
    expect(service.getRawIcs(LOCAL_DEFAULT_ID, saved.uid)).toContain('SEQUENCE:1')

    // survives a restart
    const again = await makeService().getEvent(LOCAL_DEFAULT_ID, saved.uid)
    expect(again.title).toBe('Zahnarzt (verschoben)')

    await service.deleteEvent(LOCAL_DEFAULT_ID, saved.uid)
    expect(service.findByUid(saved.uid)).toBeNull()
    await expect(service.getEvent(LOCAL_DEFAULT_ID, saved.uid)).rejects.toThrow('nicht gefunden')
  })

  it('stores all-day events as dates', async () => {
    const saved = await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      title: 'Urlaub',
      start: '2026-10-12',
      end: '2026-10-17',
      allDay: true,
    })
    expect([saved.start, saved.end, saved.allDay]).toEqual(['2026-10-12', '2026-10-17', true])
    expect(service.getRawIcs(LOCAL_DEFAULT_ID, saved.uid)).toContain('DTSTART;VALUE=DATE:20261012')
    const listed = await service.listEvents({ from: W(2026, 10, 14, 0), to: W(2026, 10, 15, 0) })
    expect(listed).toHaveLength(1)
  })

  it('edits one occurrence, the whole series, and deletes occurrences', async () => {
    const saved = await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      title: 'Jour fixe',
      start: W(2026, 10, 5, 7),
      end: W(2026, 10, 5, 8),
      allDay: false,
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      timezone: 'Europe/Berlin',
    })
    const range = { from: W(2026, 10, 1, 0), to: W(2026, 11, 3, 0) }
    let list = await service.listEvents(range)
    expect(list.map((e) => e.start)).toEqual([
      '2026-10-05T07:00:00.000Z',
      '2026-10-12T07:00:00.000Z',
      '2026-10-19T07:00:00.000Z',
      '2026-10-26T08:00:00.000Z',
      '2026-11-02T08:00:00.000Z',
    ])
    expect(list.every((e) => e.recurring && e.rrule === 'FREQ=WEEKLY;BYDAY=MO')).toBe(true)
    expect(new Set(list.map((e) => e.id)).size).toBe(5)

    // move the 12th to Tuesday afternoon
    const second = list[1]!
    const one = await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      uid: saved.uid,
      title: 'Jour fixe (Di)',
      start: W(2026, 10, 13, 12),
      end: W(2026, 10, 13, 13),
      allDay: false,
      scope: 'occurrence',
      occurrenceStart: second.occurrenceStart!,
    })
    expect(one.occurrenceStart).toBe('2026-10-12T07:00:00.000Z')
    expect(one.start).toBe('2026-10-13T12:00:00.000Z')
    list = await service.listEvents(range)
    expect(list.map((e) => [e.start, e.title])).toEqual([
      ['2026-10-05T07:00:00.000Z', 'Jour fixe'],
      ['2026-10-13T12:00:00.000Z', 'Jour fixe (Di)'],
      ['2026-10-19T07:00:00.000Z', 'Jour fixe'],
      ['2026-10-26T08:00:00.000Z', 'Jour fixe'],
      ['2026-11-02T08:00:00.000Z', 'Jour fixe'],
    ])
    const fetched = await service.getEvent(LOCAL_DEFAULT_ID, saved.uid, second.occurrenceStart)
    expect(fetched.title).toBe('Jour fixe (Di)')

    // delete the 19th only
    await service.deleteEvent(LOCAL_DEFAULT_ID, saved.uid, 'occurrence', list[2]!.occurrenceStart)
    list = await service.listEvents(range)
    expect(list.map((e) => e.start)).not.toContain('2026-10-19T07:00:00.000Z')
    expect(service.getRawIcs(LOCAL_DEFAULT_ID, saved.uid)).toContain(
      'EXDATE;TZID=Europe/Berlin:20261019T090000',
    )

    // rename and move the series from its 26 October occurrence: one hour later on every date
    await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      uid: saved.uid,
      title: 'Jour fixe neu',
      start: W(2026, 10, 26, 9),
      end: W(2026, 10, 26, 10),
      allDay: false,
      scope: 'series',
      occurrenceStart: list[2]!.occurrenceStart!,
    })
    list = await service.listEvents(range)
    expect(list.map((e) => [e.start, e.title])).toEqual([
      ['2026-10-05T08:00:00.000Z', 'Jour fixe neu'],
      // the moved occurrence keeps its own time, the deleted one stays deleted
      ['2026-10-13T12:00:00.000Z', 'Jour fixe (Di)'],
      ['2026-10-26T09:00:00.000Z', 'Jour fixe neu'],
      ['2026-11-02T09:00:00.000Z', 'Jour fixe neu'],
    ])

    // end the series after three dates: the override of the 12th is still one of them
    await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      uid: saved.uid,
      title: 'Jour fixe neu',
      start: W(2026, 10, 5, 8),
      end: W(2026, 10, 5, 9),
      allDay: false,
      rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
    })
    list = await service.listEvents(range)
    expect(list.map((e) => e.start)).toEqual([
      '2026-10-05T08:00:00.000Z',
      '2026-10-13T12:00:00.000Z',
    ])

    // no longer recurring: exceptions go
    const single = await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      uid: saved.uid,
      title: 'Einmalig',
      start: W(2026, 10, 5, 8),
      end: W(2026, 10, 5, 9),
      allDay: false,
      rrule: null,
    })
    expect(single.recurring).toBe(false)
    expect(await service.listEvents(range)).toHaveLength(1)
    const raw = service.getRawIcs(LOCAL_DEFAULT_ID, saved.uid)!
    expect(raw).not.toContain('RRULE:FREQ=WEEKLY')
    expect(raw).not.toContain('EXDATE')
    expect(raw).not.toContain('RECURRENCE-ID')
  })

  it('moves exceptions along when an all-day series becomes timed', async () => {
    const saved = await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      title: 'Sport',
      start: '2026-10-06',
      end: '2026-10-07',
      allDay: true,
      rrule: 'FREQ=WEEKLY;COUNT=4',
    })
    const range = { from: W(2026, 10, 1, 0), to: W(2026, 11, 1, 0) }
    let list = await service.listEvents(range)
    expect(list.map((e) => e.start)).toEqual([
      '2026-10-06',
      '2026-10-13',
      '2026-10-20',
      '2026-10-27',
    ])
    // rename the 13th only, delete the 20th
    await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      uid: saved.uid,
      title: 'Sport (Halle)',
      start: '2026-10-13',
      end: '2026-10-14',
      allDay: true,
      scope: 'occurrence',
      occurrenceStart: '2026-10-13',
    })
    await service.deleteEvent(LOCAL_DEFAULT_ID, saved.uid, 'occurrence', '2026-10-20')
    // the whole series now at 18:00–19:30, edited from the 27th
    await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      uid: saved.uid,
      title: 'Sport',
      start: W(2026, 10, 27, 17),
      end: W(2026, 10, 27, 18, 30),
      allDay: false,
      scope: 'series',
      occurrenceStart: '2026-10-27',
      timezone: 'Europe/Berlin',
    })
    list = await service.listEvents(range)
    expect(list.map((e) => [e.start, e.end, e.title])).toEqual([
      ['2026-10-06T16:00:00.000Z', '2026-10-06T17:30:00.000Z', 'Sport'],
      // the renamed occurrence follows the series to the new time
      ['2026-10-13T16:00:00.000Z', '2026-10-13T17:30:00.000Z', 'Sport (Halle)'],
      ['2026-10-27T17:00:00.000Z', '2026-10-27T18:30:00.000Z', 'Sport'],
    ])
    const raw = parseIcs(service.getRawIcs(LOCAL_DEFAULT_ID, saved.uid)!).events
    expect(raw[0]!.exdates).toEqual([
      {
        kind: 'datetime',
        tzid: 'Europe/Berlin',
        wall: { year: 2026, month: 10, day: 20, hour: 18, minute: 0, second: 0 },
      },
    ])
  })

  it('keeps foreign properties through edits (object merge)', async () => {
    const outside = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Apple Inc.//macOS 15//EN',
      'BEGIN:VEVENT',
      'UID:apple-1',
      'DTSTAMP:20260901T000000Z',
      'DTSTART;TZID=America/New_York:20261005T090000',
      'DTEND;TZID=America/New_York:20261005T100000',
      'SUMMARY:Call',
      'CATEGORIES:Kunde',
      'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=HQ:geo:40.7,-74.0',
      'ATTACH;FMTTYPE=application/pdf:https://example.org/a.pdf',
      'BEGIN:VALARM',
      'ACTION:AUDIO',
      'TRIGGER;VALUE=DATE-TIME:20261005T120000Z',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    await service.upsertIcs(LOCAL_DEFAULT_ID, outside)
    const ev = await service.getEvent(LOCAL_DEFAULT_ID, 'apple-1')
    expect(ev.timezone).toBe('America/New_York')
    await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      uid: 'apple-1',
      title: 'Call (neu)',
      start: ev.start,
      end: ev.end,
      allDay: false,
      reminders: [10],
      timezone: 'Europe/Berlin',
    })
    const raw = service.getRawIcs(LOCAL_DEFAULT_ID, 'apple-1')!.replace(/\r\n /g, '')
    expect(raw).toContain('CATEGORIES:Kunde')
    expect(raw).toContain('X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=HQ:geo:40.7,-74.0')
    expect(raw).toContain('ATTACH;FMTTYPE=application/pdf:https://example.org/a.pdf')
    // the event keeps its own zone; the absolute alarm the model cannot show stays
    expect(raw).toContain('DTSTART;TZID=America/New_York:20261005T090000')
    expect(raw).toContain('TRIGGER;VALUE=DATE-TIME:20261005T120000Z')
    expect(raw).toContain('TRIGGER:-PT10M')
    expect(raw).toContain('SUMMARY:Call (neu)')
    expect(raw).toContain('SEQUENCE:0')
  })

  it('moves an event to another calendar', async () => {
    const work = await service.createCalendar('local', 'Arbeit', '#c4314b')
    const saved = await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      title: 'Umzug',
      start: '2026-10-01',
      end: '2026-10-02',
      allDay: true,
    })
    await service.saveEvent({
      calendarId: work.id,
      uid: saved.uid,
      title: 'Umzug',
      start: '2026-10-01',
      end: '2026-10-02',
      allDay: true,
    })
    expect(service.findByUid(saved.uid)).toEqual({ calendarId: work.id })
    expect(service.getRawIcs(LOCAL_DEFAULT_ID, saved.uid)).toBeNull()
  })

  it('sends invitations and cancellations as the organizer', async () => {
    const saved = await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      title: 'Workshop',
      start: W(2026, 10, 7, 8),
      end: W(2026, 10, 7, 10),
      allDay: false,
      reminders: [15],
      attendees: [
        { email: 'anna@example.org', name: 'Anna', status: 'needs-action' },
        { email: 'bob@example.org', status: 'needs-action', optional: true },
        { email: 'benni@example.org', status: 'accepted' },
      ],
      inviteFromAccountId: ME.accountId,
      timezone: 'Europe/Berlin',
    })
    expect(saved.organizer).toEqual({ name: 'Benni Fischer', email: 'benni@example.org' })
    expect(sendItip).toHaveBeenCalledTimes(1)
    const [account, to, subject, text, ics, method] = sendItip.mock.calls[0]!
    expect([account, to, subject, method]).toEqual([
      'acc-1',
      ['anna@example.org', 'bob@example.org'],
      'Workshop',
      'REQUEST',
    ])
    expect(text).toContain('Workshop')
    expect(ics).toContain('METHOD:REQUEST')
    expect(ics).toContain('ORGANIZER;CN=Benni Fischer:mailto:benni@example.org')
    expect(ics).not.toContain('VALARM')
    expect(ics).toContain('BEGIN:VTIMEZONE')
    const invite = parseIcs(ics as string).events[0]!
    expect(invite.attendees.map((a) => [a.email, a.role, a.rsvp])).toEqual([
      ['anna@example.org', 'REQ-PARTICIPANT', true],
      ['bob@example.org', 'OPT-PARTICIPANT', true],
      ['benni@example.org', 'REQ-PARTICIPANT', true],
    ])
    // the stored copy keeps the reminder
    expect(service.getRawIcs(LOCAL_DEFAULT_ID, saved.uid)).toContain('BEGIN:VALARM')

    await service.deleteEvent(LOCAL_DEFAULT_ID, saved.uid)
    expect(sendItip).toHaveBeenCalledTimes(2)
    const cancel = sendItip.mock.calls[1]!
    expect(cancel[5]).toBe('CANCEL')
    expect(cancel[1]).toEqual(['anna@example.org', 'bob@example.org'])
    expect(cancel[2]).toMatch(/^(Abgesagt|Canceled): Workshop$/)
    const cancelled = parseIcs(cancel[4] as string)
    expect(cancelled.method).toBe('CANCEL')
    expect(cancelled.events[0]!.status).toBe('CANCELLED')
    expect(cancelled.events[0]!.sequence).toBe(1)
  })

  it('cancels a single occurrence with its RECURRENCE-ID', async () => {
    const saved = await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      title: 'Weekly',
      start: W(2026, 10, 5, 7),
      end: W(2026, 10, 5, 8),
      allDay: false,
      rrule: 'FREQ=WEEKLY',
      attendees: [{ email: 'anna@example.org', status: 'needs-action' }],
      inviteFromAccountId: ME.accountId,
      timezone: 'Europe/Berlin',
    })
    await service.deleteEvent(LOCAL_DEFAULT_ID, saved.uid, 'occurrence', '2026-10-12T07:00:00.000Z')
    const cancel = parseIcs(sendItip.mock.calls[1]![4] as string)
    expect(cancel.events).toHaveLength(1)
    expect(cancel.events[0]!.recurrenceId).toEqual({
      kind: 'datetime',
      tzid: 'Europe/Berlin',
      wall: { year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0 },
    })
    expect(cancel.events[0]!.rrule).toBeUndefined()
    const stored = parseIcs(service.getRawIcs(LOCAL_DEFAULT_ID, saved.uid)!).events[0]!
    expect(stored.exdates).toHaveLength(1)
    expect(stored.sequence).toBe(1)
  })

  it('refuses invitations for someone else’s meeting and reports failed sending', async () => {
    const theirs = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:theirs',
      'DTSTART:20261005T090000Z',
      'DTEND:20261005T100000Z',
      'ORGANIZER:mailto:boss@example.org',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:benni@example.org',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    await service.upsertIcs(LOCAL_DEFAULT_ID, theirs)
    await expect(
      service.saveEvent({
        calendarId: LOCAL_DEFAULT_ID,
        uid: 'theirs',
        title: 'x',
        start: W(2026, 10, 5, 9),
        end: W(2026, 10, 5, 10),
        allDay: false,
        inviteFromAccountId: ME.accountId,
      }),
    ).rejects.toThrow('Organisator')
    // deleting someone else's meeting sends no cancellation
    await service.deleteEvent(LOCAL_DEFAULT_ID, 'theirs')
    expect(sendItip).not.toHaveBeenCalled()

    sendItip.mockRejectedValueOnce(new Error('SMTP kaputt'))
    await expect(
      service.saveEvent({
        calendarId: LOCAL_DEFAULT_ID,
        title: 'Mit Gästen',
        start: W(2026, 10, 5, 9),
        end: W(2026, 10, 5, 10),
        allDay: false,
        attendees: [{ email: 'anna@example.org', status: 'needs-action' }],
        inviteFromAccountId: ME.accountId,
      }),
    ).rejects.toThrow('gespeichert, aber die Einladung')
    // the event itself was saved
    expect(
      (await service.listEvents({ from: W(2026, 10, 5, 0), to: W(2026, 10, 6, 0) })).map(
        (e) => e.title,
      ),
    ).toEqual(['Mit Gästen'])
  })

  it('imports and exports .ics files', async () => {
    const file = [
      'BEGIN:VCALENDAR',
      'METHOD:PUBLISH',
      'BEGIN:VTIMEZONE',
      'TZID:W. Europe Standard Time',
      'BEGIN:STANDARD',
      'DTSTART:16010101T030000',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:16010101T020000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:imp-1',
      'DTSTART;TZID=W. Europe Standard Time:20261020T100000',
      'DTEND;TZID=W. Europe Standard Time:20261020T110000',
      'SUMMARY:Import A',
      'X-CUSTOM:bleibt',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20261021',
      'SUMMARY:Ohne UID',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:imp-2',
      'DTSTART:20261022T100000Z',
      'RRULE:FREQ=DAILY;COUNT=2',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:imp-2',
      'RECURRENCE-ID:20261023T100000Z',
      'DTSTART:20261023T150000Z',
      'SUMMARY:verschoben',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    expect(await service.importIcs(LOCAL_DEFAULT_ID, file)).toBe(3)
    const list = await service.listEvents({ from: W(2026, 10, 19, 0), to: W(2026, 10, 25, 0) })
    expect(list.map((e) => e.title)).toEqual(['Import A', 'Ohne UID', '', 'verschoben'])
    expect(list[0]!.start).toBe('2026-10-20T08:00:00.000Z')
    const raw = service.getRawIcs(LOCAL_DEFAULT_ID, 'imp-1')!
    expect(raw).toContain('X-CUSTOM:bleibt')
    expect(raw).toContain('TZID:W. Europe Standard Time')
    expect(raw).not.toContain('METHOD')

    const exported = await service.exportIcs(LOCAL_DEFAULT_ID)
    expect(exported).toContain('X-WR-CALNAME:Kalender')
    expect(exported.match(/BEGIN:VEVENT/g)).toHaveLength(4)
    expect(exported.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1)
    expect(
      parseIcs(exported)
        .events.map((e) => e.summary)
        .sort(),
    ).toEqual(['', 'Import A', 'Ohne UID', 'verschoben'])

    await expect(service.importIcs(LOCAL_DEFAULT_ID, 'nichts')).rejects.toThrow('keine Termine')
  })

  it('stores invitations as received, found by UID', async () => {
    const invite = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:invite-1@contoso.com',
      'DTSTART:20261005T090000Z',
      'DTEND:20261005T100000Z',
      'SUMMARY:Einladung',
      'ORGANIZER:mailto:anna@contoso.com',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:benni@example.org',
      'X-MS-OLK-CONFTYPE:0',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    await service.upsertIcs(LOCAL_DEFAULT_ID, invite)
    expect(service.findByUid('invite-1@contoso.com')).toEqual({ calendarId: LOCAL_DEFAULT_ID })
    const raw = service.getRawIcs(LOCAL_DEFAULT_ID, 'invite-1@contoso.com')!
    expect(raw).not.toContain('METHOD')
    expect(raw).toContain('X-MS-OLK-CONFTYPE:0')
    // a newer version replaces the stored one
    await service.upsertIcs(LOCAL_DEFAULT_ID, invite.replace('SUMMARY:Einladung', 'SUMMARY:Neu'))
    const listed = await service.listEvents({ from: W(2026, 10, 5, 0), to: W(2026, 10, 6, 0) })
    expect(listed.map((e) => [e.title, e.organizer?.email, e.attendees[0]?.status])).toEqual([
      ['Neu', 'anna@contoso.com', 'accepted'],
    ])
    await service.removeByUid(LOCAL_DEFAULT_ID, 'invite-1@contoso.com')
    expect(service.findByUid('invite-1@contoso.com')).toBeNull()
    await expect(
      service.upsertIcs(LOCAL_DEFAULT_ID, 'BEGIN:VCALENDAR\nEND:VCALENDAR'),
    ).rejects.toThrow('UID')
  })

  it('shows only visible calendars unless asked for specific ones', async () => {
    const other = await service.createCalendar('local', 'Zweiter', '#8764b8')
    await service.saveEvent({
      calendarId: other.id,
      title: 'B',
      start: '2026-10-01',
      end: '2026-10-02',
      allDay: true,
    })
    await service.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      title: 'A',
      start: W(2026, 10, 1, 8),
      end: W(2026, 10, 1, 9),
      allDay: false,
    })
    const range = { from: W(2026, 9, 30, 0), to: W(2026, 10, 3, 0) }
    // all-day first on the same day, then by time
    expect((await service.listEvents(range)).map((e) => e.title)).toEqual(['B', 'A'])
    await service.updateCalendar(other.id, { visible: false })
    expect((await service.listEvents(range)).map((e) => e.title)).toEqual(['A'])
    expect(
      (await service.listEvents({ ...range, calendarIds: [other.id] })).map((e) => e.title),
    ).toEqual(['B'])
    await expect(service.listEvents({ from: 'x', to: 'y' })).rejects.toThrow('Zeitraum')
  })

  it('sets a corrupt local file aside instead of overwriting it', async () => {
    writeFileSync(join(dir, 'local-calendars.json'), '{"calendars": [broken')
    const fresh = makeService()
    await fresh.saveEvent({
      calendarId: LOCAL_DEFAULT_ID,
      title: 'neu',
      start: '2026-10-01',
      end: '2026-10-02',
      allDay: true,
    })
    const aside = readdirSync(dir).filter((f) => f.startsWith('local-calendars.json.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dir, aside[0]!), 'utf8')).toBe('{"calendars": [broken')
  })
})

describe('ICS subscriptions', () => {
  it('downloads, lists read-only and forgets on removal', async () => {
    const source = sources.save({
      id: 'feed-1',
      kind: 'ics',
      name: 'Feiertage',
      url: 'webcal://example.org/f.ics',
      secret: 'plain:',
    })
    dav.feed = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:h1',
      'DTSTART;VALUE=DATE:20261003',
      'SUMMARY:Tag der Deutschen Einheit',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20261225',
      'SUMMARY:Weihnachten (ohne UID)',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    await service.testSource(source, '')
    await service.syncSource(source)
    const cal = service.listCalendars().find((c) => c.sourceId === 'feed-1')!
    expect(cal).toMatchObject({
      id: 'feed-1:ics',
      name: 'Feiertage',
      readOnly: true,
      color: '#c4314b',
    })
    const list = await service.listEvents({ from: W(2026, 10, 1, 0), to: W(2027, 1, 1, 0) })
    expect(list.map((e) => [e.title, e.readOnly])).toEqual([
      ['Tag der Deutschen Einheit', true],
      ['Weihnachten (ohne UID)', true],
    ])
    // a stable stand-in id for events without UID
    const again = await makeService().listEvents({ from: W(2026, 10, 1, 0), to: W(2027, 1, 1, 0) })
    expect(again[1]!.id).toBe(list[1]!.id)
    await expect(
      service.saveEvent({
        calendarId: cal.id,
        title: 'x',
        start: '2026-10-01',
        end: '2026-10-02',
        allDay: true,
      }),
    ).rejects.toThrow('schreibgeschützt')
    expect(service.findByUid('h1')).toBeNull()

    sources.remove('feed-1')
    service.forgetSource('feed-1')
    expect(existsSync(join(dir, 'ics-feed-1.json'))).toBe(false)

    dav.feed = ''
    await expect(service.testSource(source, '')).rejects.toThrow('kein Kalender gefunden')
  })
})

describe('CalDAV', () => {
  const HOME = 'https://dav.example.org/calendars/benni/'
  let server: FakeDav

  const event = (uid: string, summary: string, start = '20261005T090000Z') =>
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTART:${start}`,
      'DTEND:20261005T100000Z',
      `SUMMARY:${summary}`,
      'X-SERVER:keep',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')

  beforeEach(() => {
    server = new FakeDav()
    server.calendars.push(
      {
        url: `${HOME}personal/`,
        displayName: 'Persönlich',
        ctag: 'c1',
        components: ['VEVENT', 'VTODO'],
        color: '#FF2968FF',
        objects: new Map(),
      },
      {
        url: `${HOME}tasks/`,
        displayName: 'Aufgaben',
        ctag: 'c1',
        components: ['VTODO'],
        objects: new Map(),
      },
      {
        url: `${HOME}shared/`,
        displayName: 'Geteilt',
        ctag: 'c1',
        components: [],
        privileges: ['read', 'read-current-user-privilege-set'],
        objects: new Map(),
      },
    )
    server.put(`${HOME}personal/`, 'a.ics', event('a', 'Alpha'))
    server.put(`${HOME}shared/`, 's.ics', event('s', 'Shared'))
    dav.client = server
    sources.save({
      id: 'dav-1',
      kind: 'caldav',
      name: 'Nextcloud',
      url: 'https://dav.example.org',
      user: 'benni',
      secret: 'plain:pw',
    })
  })

  const source = () => sources.get('dav-1')!

  it('syncs collections, skips task lists and reads privileges', async () => {
    await service.testSource(source(), 'pw')
    await service.syncSource(source())
    const cals = service.listCalendars().filter((c) => c.sourceId === 'dav-1')
    expect(cals.map((c) => [c.id, c.name, c.color, c.readOnly])).toEqual([
      ['dav-1:/calendars/benni/personal', 'Persönlich', '#ff2968', false],
      ['dav-1:/calendars/benni/shared', 'Geteilt', expect.stringMatching(/^#/), true],
    ])
    const list = await service.listEvents({ from: W(2026, 10, 5, 0), to: W(2026, 10, 6, 0) })
    expect(list.map((e) => [e.title, e.readOnly])).toEqual([
      ['Alpha', false],
      ['Shared', true],
    ])
    // the cache serves a fresh service without network
    dav.client = null
    const offline = makeService()
    expect(
      (await offline.listEvents({ from: W(2026, 10, 5, 0), to: W(2026, 10, 6, 0) })).map(
        (e) => e.title,
      ),
    ).toEqual(['Alpha', 'Shared'])
  })

  it('downloads only what changed', async () => {
    await service.syncSource(source())
    server.calls = []
    await service.syncSource(source())
    // ctags unchanged: nothing listed, nothing fetched
    expect(server.calls).toEqual([])

    server.put(`${HOME}personal/`, 'b.ics', event('b', 'Beta'))
    await service.syncSource(source())
    expect(server.calls).toEqual(['query /calendars/benni/personal/', 'multiget 1'])
    const titles = (
      await service.listEvents({ from: W(2026, 10, 5, 0), to: W(2026, 10, 6, 0) })
    ).map((e) => e.title)
    expect(titles.sort()).toEqual(['Alpha', 'Beta', 'Shared'])

    // deleted on the server → gone here
    server.calendars[0]!.objects.delete('/calendars/benni/personal/a.ics')
    server.bump(`${HOME}personal/`)
    await service.syncSource(source())
    expect(service.findByUid('a')).toBeNull()
  })

  it('writes to the server first, keeping etags and foreign properties', async () => {
    await service.syncSource(source())
    const calendarId = 'dav-1:/calendars/benni/personal'
    const created = await service.saveEvent({
      calendarId,
      title: 'Neu',
      start: W(2026, 10, 8, 7),
      end: W(2026, 10, 8, 8),
      allDay: false,
      timezone: 'Europe/Berlin',
    })
    const filename = `${encodeURIComponent(created.uid)}.ics`
    expect(server.createCalendarObject).toHaveBeenCalledWith(expect.objectContaining({ filename }))
    const onServer = server.calendars[0]!.objects.get(`/calendars/benni/personal/${filename}`)!
    expect(onServer.data).toContain('SUMMARY:Neu')

    await service.saveEvent({
      calendarId,
      uid: 'a',
      title: 'Alpha 2',
      start: W(2026, 10, 5, 9),
      end: W(2026, 10, 5, 10),
      allDay: false,
    })
    const update = server.updateCalendarObject.mock.calls[0]![0] as {
      calendarObject: { etag: string; data: string }
    }
    expect(update.calendarObject.etag).toMatch(/^"e\d+"$/)
    expect(update.calendarObject.data).toContain('X-SERVER:keep')
    expect(server.calendars[0]!.objects.get('/calendars/benni/personal/a.ics')!.data).toContain(
      'SUMMARY:Alpha 2',
    )

    await service.deleteEvent(calendarId, created.uid)
    expect(server.calendars[0]!.objects.has(`/calendars/benni/personal/${filename}`)).toBe(false)
  })

  it('reports an etag conflict and reloads the calendar', async () => {
    await service.syncSource(source())
    const calendarId = 'dav-1:/calendars/benni/personal'
    // someone else edits the event meanwhile
    server.put(`${HOME}personal/`, 'a.ics', event('a', 'Alpha (Handy)'))
    await expect(
      service.saveEvent({
        calendarId,
        uid: 'a',
        title: 'Alpha (Desktop)',
        start: W(2026, 10, 5, 9),
        end: W(2026, 10, 5, 10),
        allDay: false,
      }),
    ).rejects.toThrow('anderen Gerät')
    const list = await service.listEvents({
      from: W(2026, 10, 5, 0),
      to: W(2026, 10, 6, 0),
      calendarIds: [calendarId],
    })
    expect(list.map((e) => e.title)).toEqual(['Alpha (Handy)'])
    // the retry goes through
    await service.saveEvent({
      calendarId,
      uid: 'a',
      title: 'Alpha (Desktop)',
      start: W(2026, 10, 5, 9),
      end: W(2026, 10, 5, 10),
      allDay: false,
    })
    expect(server.calendars[0]!.objects.get('/calendars/benni/personal/a.ics')!.data).toContain(
      'Alpha (Desktop)',
    )
  })

  it('stores invitations with SCHEDULE-AGENT=CLIENT and creates calendars', async () => {
    await service.syncSource(source())
    const calendarId = 'dav-1:/calendars/benni/personal'
    await service.saveEvent({
      calendarId,
      title: 'Meeting',
      start: W(2026, 10, 9, 7),
      end: W(2026, 10, 9, 8),
      allDay: false,
      attendees: [{ email: 'anna@example.org', status: 'needs-action' }],
      inviteFromAccountId: ME.accountId,
    })
    const stored = [...server.calendars[0]!.objects.values()].find((o) =>
      o.data.includes('Meeting'),
    )!
    expect(stored.data.replace(/\r\n /g, '')).toContain('SCHEDULE-AGENT=CLIENT')
    expect(sendItip.mock.calls[0]![4]).not.toContain('SCHEDULE-AGENT')

    await service.upsertIcs(
      calendarId,
      'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:inv\r\nDTSTART:20261010T090000Z\r\nORGANIZER:mailto:boss@example.org\r\nEND:VEVENT\r\nEND:VCALENDAR',
    )
    const inv = [...server.calendars[0]!.objects.values()].find((o) => o.data.includes('UID:inv'))!
    expect(inv.data).not.toContain('METHOD')
    expect(inv.data).toContain('ORGANIZER;SCHEDULE-AGENT=CLIENT:mailto:boss@example.org')

    const created = await service.createCalendar('dav-1', 'Projekte', '#038387')
    expect(created.name).toBe('Projekte')
    expect(created.color).toBe('#038387')
    expect(server.makeCalendar.mock.calls[0]![0].url).toMatch(
      /^https:\/\/dav\.example\.org\/calendars\/benni\/[0-9a-f-]+\/$/,
    )
  })

  it('refuses writes to read-only collections', async () => {
    await service.syncSource(source())
    await expect(service.deleteEvent('dav-1:/calendars/benni/shared', 's')).rejects.toThrow(
      'schreibgeschützt',
    )
    expect(server.deleteCalendarObject).not.toHaveBeenCalled()
  })
})

describe('pure CalDAV helpers', () => {
  it('diff cached objects against an etag listing', () => {
    const cached = [
      { url: 'https://h/c/a.ics', etag: '"1"', ics: 'A' },
      { url: 'https://h/c/b%20x.ics', etag: '"2"', ics: 'B' },
      { url: 'https://h/c/gone.ics', etag: '"3"', ics: 'G' },
    ]
    const { keep, fetch } = diffObjects(cached, [
      { url: 'https://h/c/a.ics', etag: '"1"' },
      { url: 'https://h/c/b x.ics', etag: '"9"' },
      { url: 'https://h/c/new.ics', etag: '"4"' },
      { url: 'https://h/c/noetag.ics' },
    ])
    expect(keep.map((o) => o.ics)).toEqual(['A'])
    expect(fetch).toEqual(['https://h/c/b x.ics', 'https://h/c/new.ics', 'https://h/c/noetag.ics'])
  })

  it('plan which collections to reload', () => {
    const cached = [
      {
        key: '/a',
        url: 'u/a',
        displayName: 'A',
        ctag: '1',
        readOnly: false,
        synced: true,
        objects: [{ url: 'x', ics: 'X' }],
      },
      {
        key: '/b',
        url: 'u/b',
        displayName: 'B',
        ctag: '1',
        readOnly: false,
        synced: true,
        objects: [],
      },
      { key: '/gone', url: 'u/g', displayName: 'G', readOnly: false, objects: [] },
    ]
    const plan = planCalendarSync(cached, [
      {
        key: '/a',
        url: 'u/a',
        displayName: 'A2',
        ctag: '1',
        readOnly: false,
        components: ['VEVENT'],
      },
      { key: '/b', url: 'u/b', displayName: 'B', ctag: '2', readOnly: true, components: [] },
      { key: '/c', url: 'u/c', displayName: 'C', readOnly: false, components: ['VEVENT'] },
      { key: '/t', url: 'u/t', displayName: 'T', readOnly: false, components: ['VTODO'] },
    ])
    expect(plan.calendars.map((c) => [c.key, c.displayName, c.readOnly, c.objects.length])).toEqual(
      [
        ['/a', 'A2', false, 1],
        ['/b', 'B', true, 0],
        ['/c', 'C', false, 0],
      ],
    )
    expect(plan.stale).toEqual(['/b', '/c'])
    // the old ctag stays until the objects were actually reloaded
    expect(plan.calendars[1]!.ctag).toBe('1')
  })

  it('normalize colors, privileges, keys and file names', () => {
    expect(normalizeColor('#FF2968FF')).toBe('#ff2968')
    expect(normalizeColor('#abc')).toBe('#aabbcc')
    expect(normalizeColor('red')).toBeUndefined()
    expect(privilegesReadOnly({ privilege: [{ read: {} }, { writeContent: {} }] })).toBe(false)
    expect(privilegesReadOnly({ privilege: { read: {} } })).toBe(true)
    expect(privilegesReadOnly(undefined)).toBe(false)
    expect(collectionKey('https://h/remote.php/dav/calendars/b/personal%20x/')).toBe(
      '/remote.php/dav/calendars/b/personal x',
    )
    expect(collectionKey('https://h/a|b/')).toBe('/a%7Cb')
    expect(objectFilename('abc@suite-office')).toBe('abc%40suite-office.ics')
    expect(objectFilename('x'.repeat(300))).toMatch(/^[0-9a-f]{40}\.ics$/)
    const prepared = prepareStoredIcs(
      'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nUID:1\r\nATTENDEE;SCHEDULE-STATUS=2.0:mailto:a@b.c\r\nEND:VEVENT\r\nEND:VCALENDAR',
      true,
    )
    expect(prepared).not.toContain('METHOD')
    expect(prepared).toContain('ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:a@b.c')
  })
})
