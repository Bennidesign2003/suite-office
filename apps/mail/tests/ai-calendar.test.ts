import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../src/shared/pim'

const runAi = vi.fn()
vi.mock('../src/renderer/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/ai')>()),
  runAi: (...args: unknown[]) => runAi(...args),
}))

const {
  agendaPrompt,
  draftEventFromMail,
  eventDraftPrompt,
  findFreeSlots,
  mailEventPrompt,
  meetingPrepPrompt,
  parseEventDraft,
} = await import('../src/renderer/calendar/ai-calendar')

// Wednesday, 30 September 2026, 14:00 in Berlin
const NOW = '2026-09-30T12:00:00.000Z'
const BERLIN = 'Europe/Berlin'

function event(partial: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'x',
    uid: 'u',
    calendarId: 'local:default',
    title: 'Termin',
    location: '',
    description: '',
    start: '',
    end: '',
    allDay: false,
    recurring: false,
    status: 'confirmed',
    attendees: [],
    reminders: [],
    readOnly: false,
    ...partial,
  }
}

/** an ISO instant for a wall time on the computer's own clock (tests run in any TZ) */
const local = (y: number, m: number, d: number, h = 0, min = 0): string =>
  new Date(y, m - 1, d, h, min).toISOString()

describe('parseEventDraft', () => {
  it('reads a clean answer and turns Berlin wall time into UTC (summer time)', () => {
    const draft = parseEventDraft(
      '{"title": "Zahnarzt", "date": "2026-10-01", "start": "15:00", "end": null, "durationMinutes": 60, "allDay": false, "location": "Hauptstraße 5", "description": "", "attendees": [], "rrule": null}',
      NOW,
      BERLIN,
    )
    expect(draft).toEqual({
      title: 'Zahnarzt',
      start: '2026-10-01T13:00:00.000Z',
      end: '2026-10-01T14:00:00.000Z',
      allDay: false,
      timezone: BERLIN,
      location: 'Hauptstraße 5',
    })
  })

  it('finds the object inside prose and a Markdown fence', () => {
    const answer =
      'Klar! Hier ist der Termin:\n```json\n{\n  "title": "Team-Meeting",\n  "date": "2026-10-02",\n  "start": "09:30",\n  "end": "11:00",\n  "allDay": false\n}\n```\nSag Bescheid, wenn du etwas ändern willst.'
    const draft = parseEventDraft(answer, NOW, BERLIN)
    expect(draft?.title).toBe('Team-Meeting')
    expect(draft?.start).toBe('2026-10-02T07:30:00.000Z')
    expect(draft?.end).toBe('2026-10-02T09:00:00.000Z')
  })

  it('tolerates single quotes, unquoted keys, trailing commas and comments', () => {
    const answer = `Sure: {title: 'Lunch with Maria', 'date': '2026-10-09', start: '12:30', // noon-ish
      durationMinutes: 45, attendees: ['Maria <maria@example.org>', 'not an address', 'MARIA@example.org',],
      rrule: null,}`
    const draft = parseEventDraft(answer, NOW, BERLIN)
    expect(draft?.title).toBe('Lunch with Maria')
    expect(draft?.start).toBe('2026-10-09T10:30:00.000Z')
    expect(draft?.end).toBe('2026-10-09T11:15:00.000Z')
    expect(draft?.attendees).toEqual([
      { email: 'maria@example.org', name: 'Maria', status: 'needs-action' },
    ])
    expect(draft).not.toHaveProperty('rrule')
  })

  it('makes an event without a time all-day, with an exclusive end date', () => {
    const draft = parseEventDraft(
      '{"title": "Urlaub", "date": "2026-10-05", "start": null, "end": null, "allDay": true}',
      NOW,
      BERLIN,
    )
    expect(draft).toMatchObject({
      title: 'Urlaub',
      start: '2026-10-05',
      end: '2026-10-06',
      allDay: true,
    })
  })

  it('spans several days when the model names a last day or a day-sized duration', () => {
    expect(
      parseEventDraft(
        '{"title":"Messe","date":"2026-10-12","endDate":"2026-10-14","allDay":true}',
        NOW,
        BERLIN,
      ),
    ).toMatchObject({ start: '2026-10-12', end: '2026-10-15', allDay: true })
    expect(
      parseEventDraft(
        '{"title":"Reise","date":"2026-10-12","allDay":true,"durationMinutes":2880}',
        NOW,
        BERLIN,
      ),
    ).toMatchObject({ start: '2026-10-12', end: '2026-10-14' })
  })

  it('treats "allDay": true with a real clock time as timed, but 00:00 as all-day', () => {
    expect(
      parseEventDraft(
        '{"title":"Arzt","date":"2026-10-01","start":"15:00","allDay":true}',
        NOW,
        BERLIN,
      )?.allDay,
    ).toBe(false)
    expect(
      parseEventDraft(
        '{"title":"Geburtstag","date":"2026-10-01","start":"00:00","end":"23:59","allDay":false}',
        NOW,
        BERLIN,
      ),
    ).toMatchObject({ allDay: true, start: '2026-10-01', end: '2026-10-02' })
  })

  it('defaults to 60 minutes, honours durations and puts an earlier end on the next day', () => {
    const base = '"title":"X","date":"2026-10-01","start":"22:00"'
    expect(parseEventDraft(`{${base}}`, NOW, BERLIN)?.end).toBe('2026-10-01T21:00:00.000Z')
    expect(parseEventDraft(`{${base},"durationMinutes":"1,5 h"}`, NOW, BERLIN)?.end).toBe(
      '2026-10-01T21:30:00.000Z',
    )
    expect(parseEventDraft(`{${base},"end":"01:00"}`, NOW, BERLIN)?.end).toBe(
      '2026-10-01T23:00:00.000Z',
    )
    expect(parseEventDraft(`{${base},"end":"24:00"}`, NOW, BERLIN)?.end).toBe(
      '2026-10-01T22:00:00.000Z',
    )
  })

  it('reads the clock notations small models produce', () => {
    const at = (start: unknown): string | undefined =>
      parseEventDraft(JSON.stringify({ title: 'X', date: '2026-10-01', start }), NOW, 'UTC')?.start
    expect(at('15 Uhr')).toBe('2026-10-01T15:00:00.000Z')
    expect(at('3pm')).toBe('2026-10-01T15:00:00.000Z')
    expect(at('9.30')).toBe('2026-10-01T09:30:00.000Z')
    expect(at('2026-10-01T08:15:00Z')).toBe('2026-10-01T08:15:00.000Z')
    expect(at(14)).toBe('2026-10-01T14:00:00.000Z')
    // an unreadable time leaves an all-day draft rather than a made-up hour
    expect(
      parseEventDraft('{"title":"X","date":"2026-10-01","start":"nachmittags"}', NOW, 'UTC'),
    ).toMatchObject({
      allDay: true,
    })
  })

  it('returns null for unusable answers', () => {
    expect(parseEventDraft('', NOW, BERLIN)).toBeNull()
    expect(parseEventDraft('Ich konnte keinen Termin finden.', NOW, BERLIN)).toBeNull()
    expect(parseEventDraft('{"title": null, "date": null}', NOW, BERLIN)).toBeNull()
    expect(
      parseEventDraft('{"title": "X", "date": "2026-02-30", "start": "10:00"}', NOW, BERLIN),
    ).toBeNull()
    expect(parseEventDraft('{"title": "X", "date": "2026-13-01"}', NOW, BERLIN)).toBeNull()
    expect(parseEventDraft('{"title": "X", "date": "irgendwann"}', NOW, BERLIN)).toBeNull()
    expect(parseEventDraft('{"title": "X"}', NOW, BERLIN)).toBeNull()
    expect(parseEventDraft('{{{{[[[', NOW, BERLIN)).toBeNull()
    expect(parseEventDraft('{"a":'.repeat(200), NOW, BERLIN)).toBeNull()
  })

  it('skips a broken object and a <think> block to reach the real answer', () => {
    const answer =
      '<think>maybe {"title":"Falsch","date":"2026-01-01"}</think>Format: {title}. Antwort: {"title":"Richtig","date":"2026-10-03"}'
    expect(parseEventDraft(answer, NOW, BERLIN)?.title).toBe('Richtig')
  })

  it('unwraps {"event": {...}} and understands German keys', () => {
    expect(
      parseEventDraft(
        '{"event": {"title": "Yoga", "date": "2026-10-06", "start": "18:00"}}',
        NOW,
        BERLIN,
      )?.title,
    ).toBe('Yoga')
    const german = parseEventDraft(
      '{"Titel": "Friseur", "Datum": "02.10.2026", "Beginn": "10 Uhr", "Ort": "Salon Haarmonie"}',
      NOW,
      BERLIN,
    )
    expect(german).toMatchObject({
      title: 'Friseur',
      start: '2026-10-02T08:00:00.000Z',
      location: 'Salon Haarmonie',
    })
  })

  it('resolves relative dates the model left unresolved', () => {
    const dateOf = (date: string): string | undefined =>
      parseEventDraft(JSON.stringify({ title: 'X', date }), NOW, BERLIN)?.start
    expect(dateOf('morgen')).toBe('2026-10-01')
    expect(dateOf('übermorgen')).toBe('2026-10-02')
    expect(dateOf('Donnerstag')).toBe('2026-10-01')
    expect(dateOf('Mittwoch')).toBe('2026-10-07')
    expect(dateOf('nächste Woche Dienstag')).toBe('2026-10-06')
    expect(dateOf('next week')).toBe('2026-10-05')
    expect(dateOf('1.10.')).toBe('2026-10-01')
    expect(dateOf('Donnerstag, 1. Oktober 2026')).toBe('2026-10-01')
    expect(dateOf('Freitag 2. Oktober 2026')).toBe('2026-10-02')
    expect(dateOf('Fri, Oct 9')).toBe('2026-10-09')
    expect(dateOf('October 2nd, 2026')).toBe('2026-10-02')
    expect(dateOf('3 Dec')).toBe('2026-12-03')
    expect(dateOf('1. März')).toBe('2027-03-01')
    expect(dateOf('31. Februar 2026')).toBeUndefined()
    // a day-month that has passed this year means next year
    expect(dateOf('15.3.')).toBe('2027-03-15')
  })

  it('keeps a plain date when "now" falls on a different day in the event zone', () => {
    // 23:30 UTC on 30 Sep is already 1 Oct in Berlin
    const draft = parseEventDraft('{"title":"X","date":"morgen"}', '2026-09-30T23:30:00Z', BERLIN)
    expect(draft?.start).toBe('2026-10-02')
  })

  it('handles DST transitions in Berlin and New York', () => {
    const at = (date: string, start: string, zone: string): string | undefined =>
      parseEventDraft(JSON.stringify({ title: 'X', date, start }), NOW, zone)?.start
    // Berlin: CET until 29 Mar 2026 02:00, CEST until 25 Oct 2026 03:00
    expect(at('2026-03-28', '10:00', BERLIN)).toBe('2026-03-28T09:00:00.000Z')
    expect(at('2026-03-29', '10:00', BERLIN)).toBe('2026-03-29T08:00:00.000Z')
    expect(at('2026-10-24', '10:00', BERLIN)).toBe('2026-10-24T08:00:00.000Z')
    expect(at('2026-10-25', '10:00', BERLIN)).toBe('2026-10-25T09:00:00.000Z')
    // a time in the spring-forward gap moves forward (02:30 → 03:30 CEST)
    expect(at('2026-03-29', '02:30', BERLIN)).toBe('2026-03-29T01:30:00.000Z')
    // in the autumn overlap the earlier instant wins (02:30 CEST)
    expect(at('2026-10-25', '02:30', BERLIN)).toBe('2026-10-25T00:30:00.000Z')
    // New York leaves DST on 1 Nov 2026
    expect(at('2026-10-31', '09:00', 'America/New_York')).toBe('2026-10-31T13:00:00.000Z')
    expect(at('2026-11-01', '09:00', 'America/New_York')).toBe('2026-11-01T14:00:00.000Z')
  })

  it('keeps meeting length in real time across a DST change', () => {
    const draft = parseEventDraft(
      '{"title":"Nachtschicht","date":"2026-10-24","start":"22:00","end":"06:00"}',
      NOW,
      BERLIN,
    )
    // 22:00 CEST → 06:00 CET is nine hours
    expect(draft?.start).toBe('2026-10-24T20:00:00.000Z')
    expect(draft?.end).toBe('2026-10-25T05:00:00.000Z')
  })

  it('sanitizes recurrence rules', () => {
    const rule = (rrule: unknown): string | null | undefined =>
      parseEventDraft(
        `{"title":"X","date":"2026-10-05","start":"09:00","rrule":${JSON.stringify(rrule)}}`,
        NOW,
        BERLIN,
      )?.rrule
    expect(rule('RRULE:FREQ=WEEKLY;BYDAY=MO;X-FOO=BAR')).toBe('FREQ=WEEKLY;BYDAY=MO')
    expect(rule('weekly')).toBe('FREQ=WEEKLY')
    expect(rule('alle zwei Wochen')).toBe('FREQ=WEEKLY;INTERVAL=2')
    expect(rule('FREQ=SOMETIMES')).toBeUndefined()
    expect(rule('FREQ=DAILY;COUNT=5;UNTIL=20261231')).toBe('FREQ=DAILY;COUNT=5')
    // a timed series ends at the end of that day on the user's clock, in UTC
    expect(rule('FREQ=WEEKLY;UNTIL=20261231')).toBe('FREQ=WEEKLY;UNTIL=20261231T225959Z')
    expect(
      parseEventDraft(
        '{"title":"X","date":"2026-10-05","allDay":true,"rrule":"FREQ=YEARLY;UNTIL=20301005T000000Z"}',
        NOW,
        BERLIN,
      )?.rrule,
    ).toBe('FREQ=YEARLY;UNTIL=20301005')
  })

  it('survives hostile keys and a truncated answer', () => {
    const polluted = parseEventDraft(
      '{"__proto__": {"polluted": true}, "title": "X", "date": "2026-10-01"}',
      NOW,
      BERLIN,
    )
    expect(polluted?.title).toBe('X')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    const cut = parseEventDraft(
      '{"title": "Zahnarzt", "date": "2026-10-01", "start": "15:00", "description": "Bitte Versichertenk',
      NOW,
      BERLIN,
    )
    expect(cut).toMatchObject({ title: 'Zahnarzt', start: '2026-10-01T13:00:00.000Z' })
  })

  it('falls back to the computer’s zone when the given one is unknown', () => {
    const draft = parseEventDraft(
      '{"title":"X","date":"2026-10-01","start":"10:00"}',
      NOW,
      'Mars/Olympus',
    )
    expect(draft?.start).toBe(local(2026, 10, 1, 10))
    expect(draft?.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})

describe('prompts', () => {
  it('tells the model today, the weekday, the zone and a table of coming days', () => {
    const p = eventDraftPrompt('Zahnarzt Donnerstag 15 Uhr', NOW, BERLIN, 'de')
    expect(p.system).toContain('Today is Wednesday, 2026-09-30')
    expect(p.system).toContain('14:00 in the time zone Europe/Berlin')
    expect(p.system).toContain('2026-10-01 Thursday / Donnerstag (tomorrow)')
    expect(p.system).toContain('2026-10-05 Monday / Montag (start of next week)')
    // the worked example uses a correctly computed date ("next week Friday")
    expect(p.system).toContain('"date": "2026-10-09"')
    expect(p.system).toContain('"durationMinutes": number')
    expect(p.user).toBe('Appointment: Zahnarzt Donnerstag 15 Uhr')
  })

  it('frames an email with its sent date and attendee rules', () => {
    const p = mailEventPrompt(
      {
        from: 'Praxis <info@praxis.de>',
        to: 'me@example.org',
        subject: 'Terminbestätigung',
        date: '28.9.2026, 10:00:00',
        body: 'Ihr Termin: Do 1.10. 9 Uhr',
      },
      NOW,
      BERLIN,
      'en',
    )
    expect(p.system).toContain('relative dates in it count from the date it was sent')
    expect(p.system).toContain('never shops, companies, doctors')
    expect(p.system).not.toContain(' / ')
    expect(p.user).toContain('Sent: 28.9.2026, 10:00:00')
    expect(p.user).toContain('Subject: Terminbestätigung')
    expect(p.user).toContain('Ihr Termin: Do 1.10. 9 Uhr')
  })

  it('lists the agenda in order and computes overlaps itself', () => {
    const events = [
      event({ title: 'Später', start: local(2026, 10, 5, 14), end: local(2026, 10, 5, 15) }),
      event({ title: 'Standup', start: local(2026, 10, 5, 9), end: local(2026, 10, 5, 10) }),
      event({
        title: 'Kunde',
        start: local(2026, 10, 5, 9, 30),
        end: local(2026, 10, 5, 11),
        location: 'Büro',
      }),
      event({
        title: 'Abgesagt',
        start: local(2026, 10, 6, 9),
        end: local(2026, 10, 6, 10),
        status: 'cancelled',
      }),
      event({ title: 'Feiertag', start: '2026-10-03', end: '2026-10-04', allDay: true }),
    ]
    const p = agendaPrompt(events, { from: local(2026, 10, 3), to: local(2026, 10, 10) }, 'de')
    expect(p.system).toContain('in German')
    expect(p.user).toContain('Period: Sat 2026-10-03 – Fri 2026-10-09')
    const order = ['Feiertag', 'Standup', 'Kunde', 'Später', 'Abgesagt'].map((title) =>
      p.user.indexOf(title),
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(p.user).toContain('- Mon 2026-10-05 09:30–11:00: Kunde at Büro')
    expect(p.user).toContain('Sat 2026-10-03, all day: Feiertag')
    expect(p.user).toContain('[CANCELLED]')
    expect(p.user).toContain('"Standup" and "Kunde"')
    expect(p.user).not.toContain('"Kunde" and "Später"')
    expect(
      agendaPrompt([], { from: local(2026, 10, 3), to: local(2026, 10, 4) }, 'en').user,
    ).toContain('(none)')
  })

  it('gives the meeting details for preparation', () => {
    const p = meetingPrepPrompt(
      event({
        title: 'Quartalsplanung',
        start: local(2026, 10, 7, 10),
        end: local(2026, 10, 7, 11, 30),
        description: 'Budget 2027 und Roadmap',
        organizer: { name: 'Anna', email: 'anna@firma.de' },
        attendees: [
          { name: 'Ben', email: 'ben@firma.de', status: 'accepted' },
          { email: 'carl@firma.de', status: 'needs-action', optional: true },
        ],
      }),
      'en',
    )
    expect(p.system).toContain('in English')
    expect(p.user).toContain('Title: Quartalsplanung')
    expect(p.user).toContain('When: Wed 2026-10-07 10:00–11:30')
    expect(p.user).toContain('Organizer: Anna <anna@firma.de>')
    expect(p.user).toContain('- Ben <ben@firma.de> (accepted)')
    expect(p.user).toContain('- carl@firma.de (no answer yet, optional)')
    expect(p.user).toContain('Budget 2027 und Roadmap')
  })
})

describe('draftEventFromMail', () => {
  afterEach(() => runAi.mockReset())

  const mail = {
    from: 'Anna <anna@firma.de>',
    to: 'me@example.org',
    subject: 'AW: Projekttreffen',
    date: '30.9.2026, 09:00:00',
    body: 'Lass uns am 2.10. um 10 Uhr sprechen.',
  }

  it('runs the model and parses its answer, titling it after the subject if needed', async () => {
    runAi.mockReturnValue({
      cancel() {},
      done: Promise.resolve('{"title": "", "date": "2099-10-02", "start": "10:00"}'),
    })
    const draft = await draftEventFromMail(mail, 'de')
    expect(runAi).toHaveBeenCalledTimes(1)
    expect(String(runAi.mock.calls[0]![1])).toContain('Lass uns am 2.10.')
    expect(draft?.title).toBe('Projekttreffen')
    expect(draft?.allDay).toBe(false)
  })

  it('asks once more when the model answered without JSON, and gives null for no event', async () => {
    runAi
      .mockReturnValueOnce({ cancel() {}, done: Promise.resolve('Das ist ein Termin am Freitag.') })
      .mockReturnValueOnce({ cancel() {}, done: Promise.resolve('{"title": null, "date": null}') })
    expect(await draftEventFromMail(mail, 'de')).toBeNull()
    expect(runAi).toHaveBeenCalledTimes(2)
  })

  it('passes a missing-model error through', async () => {
    const { AiUnconfiguredError } = await import('../src/renderer/ai')
    runAi.mockReturnValue({
      cancel() {},
      done: Promise.reject(new AiUnconfiguredError('no model')),
    })
    await expect(draftEventFromMail(mail, 'de')).rejects.toBeInstanceOf(AiUnconfiguredError)
  })
})

describe('findFreeSlots', () => {
  const MON = [2026, 10, 5] as const

  it('fills an empty working day with back-to-back slots', () => {
    const slots = findFreeSlots([], local(...MON, 0), local(...MON, 23, 59), 60)
    expect(slots).toHaveLength(10)
    expect(slots[0]).toEqual({ start: local(...MON, 8), end: local(...MON, 9) })
    expect(slots[9]).toEqual({ start: local(...MON, 17), end: local(...MON, 18) })
  })

  it('merges overlapping events and resumes on the grid after them', () => {
    const events = [
      event({ start: local(...MON, 9), end: local(...MON, 10) }),
      event({ start: local(...MON, 9, 30), end: local(...MON, 11, 10) }),
      event({ start: local(...MON, 13), end: local(...MON, 17, 30), status: 'tentative' }),
    ]
    const slots = findFreeSlots(events, local(...MON), local(...MON, 23), 60)
    expect(slots.map((s) => s.start)).toEqual([local(...MON, 8), local(...MON, 11, 30)])
  })

  it('ignores cancelled and all-day events', () => {
    const events = [
      event({ start: local(...MON, 8), end: local(...MON, 18), status: 'cancelled' }),
      event({ start: '2026-10-05', end: '2026-10-06', allDay: true }),
      event({ start: 'garbage', end: 'also garbage' }),
    ]
    expect(findFreeSlots(events, local(...MON), local(...MON, 23), 60)).toHaveLength(10)
  })

  it('skips weekends and respects custom day bounds and weekdays', () => {
    // Friday 9 Oct through Monday 12 Oct
    const from = local(2026, 10, 9)
    const to = local(2026, 10, 13)
    const days = (opts: Parameters<typeof findFreeSlots>[4]): number[] => [
      ...new Set(findFreeSlots([], from, to, 60, opts).map((s) => new Date(s.start).getDate())),
    ]
    expect(days(undefined)).toEqual([9, 12])
    expect(days({ weekdays: [0, 6] })).toEqual([10, 11])
    const short = findFreeSlots([], from, local(2026, 10, 10), 60, { dayStart: 9.5, dayEnd: 12 })
    expect(short.map((s) => s.start)).toEqual([
      local(2026, 10, 9, 9, 30),
      local(2026, 10, 9, 10, 30),
    ])
  })

  it('starts at "from" on the grid and never runs past "to"', () => {
    const slots = findFreeSlots([], local(...MON, 10, 17), local(...MON, 13, 15), 60)
    expect(slots.map((s) => s.start)).toEqual([local(...MON, 10, 30), local(...MON, 11, 30)])
  })

  it('lays long slots end to end on the step grid', () => {
    const slots = findFreeSlots([], local(...MON), local(...MON, 23), 90)
    expect(
      slots.map((s) => new Date(s.start).getHours() * 60 + new Date(s.start).getMinutes()),
    ).toEqual([480, 570, 660, 750, 840, 930])
    expect(findFreeSlots([], local(...MON), local(...MON, 23), 45, { stepMin: 15 })).toHaveLength(
      13,
    )
  })

  it('returns nothing for impossible requests', () => {
    expect(findFreeSlots([], local(...MON), local(...MON, 23), 11 * 60)).toEqual([])
    expect(findFreeSlots([], local(...MON), local(...MON, 23), 0)).toEqual([])
    expect(findFreeSlots([], 'nope', local(...MON, 23), 30)).toEqual([])
    expect(findFreeSlots([], local(...MON, 23), local(...MON), 30)).toEqual([])
    expect(
      findFreeSlots([], local(...MON), local(...MON, 23), 30, { dayStart: 18, dayEnd: 8 }),
    ).toEqual([])
  })

  it('finds a slot between events spread over a week', () => {
    const events: CalendarEvent[] = []
    for (let d = 5; d <= 9; d++) {
      events.push(event({ start: local(2026, 10, d, 8), end: local(2026, 10, d, 17) }))
    }
    events.push(event({ start: local(2026, 10, 9, 17), end: local(2026, 10, 9, 18) }))
    const slots = findFreeSlots(events, local(2026, 10, 5), local(2026, 10, 12), 60)
    expect(slots).toEqual(
      [5, 6, 7, 8].map((d) => ({ start: local(2026, 10, d, 17), end: local(2026, 10, d, 18) })),
    )
  })
})
