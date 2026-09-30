import { describe, expect, it } from 'vitest'
import { parseComponents } from '../src/main/pim/contentline'
import {
  alarmMinutes,
  buildCalendarObject,
  deriveOccurrence,
  groupByUid,
  newEvent,
  parseDuration,
  parseIcs,
  toInstant,
  type EventTime,
} from '../src/main/pim/ics'
import { buildVtimezone, ianaForVtimezone, zoneTransitions } from '../src/main/pim/vtimezone'

process.env.TZ = 'Europe/Berlin'

const crlf = (lines: string[]): string => lines.join('\r\n') + '\r\n'

const OUTLOOK_INVITE = crlf([
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'ORGANIZER;CN=Anna Müller:MAILTO:anna@contoso.com',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Benni:mailto:benni@example.org',
  'ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="Doe, John";X-NUM-GUESTS=0:mailto:john@example.org',
  'DESCRIPTION;LANGUAGE=de-DE:Agenda:\\n1. Zahlen\\n2. Ausblick',
  'UID:040000008200E00074C5B7101A82E00800000000D0A4C5F1E3D1DA01000000000000000010000000A1B2C3',
  'SUMMARY;LANGUAGE=de-DE:Quartalsplanung',
  'DTSTART;TZID=W. Europe Standard Time:20261021T140000',
  'DTEND;TZID=W. Europe Standard Time:20261021T153000',
  'CLASS:PUBLIC',
  'PRIORITY:5',
  'DTSTAMP:20261001T080000Z',
  'TRANSP:OPAQUE',
  'STATUS:CONFIRMED',
  'SEQUENCE:0',
  'LOCATION;LANGUAGE=de-DE:Raum 4.12',
  'X-MICROSOFT-CDO-APPT-SEQUENCE:0',
  'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE',
  'X-MICROSOFT-CDO-ALLDAYEVENT:FALSE',
  'X-ALT-DESC;FMTTYPE=text/html:<html><body>Agenda</body></html>',
  'BEGIN:VALARM',
  'DESCRIPTION:REMINDER',
  'TRIGGER;RELATED=START:-PT15M',
  'ACTION:DISPLAY',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
])

const GOOGLE_ALL_DAY = crlf([
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'X-WR-CALNAME:Familie',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261003',
  'DTEND;VALUE=DATE:20261004',
  'DTSTAMP:20260930T101010Z',
  'UID:7kukuqrfedlm2f9t0vh4mvn1n4@google.com',
  'CREATED:20260901T080000Z',
  'DESCRIPTION:',
  'LAST-MODIFIED:20260902T080000Z',
  'LOCATION:',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'SUMMARY:Tag der Deutschen Einheit',
  'TRANSP:TRANSPARENT',
  'END:VEVENT',
  'END:VCALENDAR',
])

describe('parseIcs', () => {
  it('reads an Outlook invitation with a Windows time zone name', () => {
    const parsed = parseIcs(OUTLOOK_INVITE)
    expect(parsed.method).toBe('REQUEST')
    expect(parsed.events).toHaveLength(1)
    const ev = parsed.events[0]!
    expect(ev.summary).toBe('Quartalsplanung')
    expect(ev.description).toBe('Agenda:\n1. Zahlen\n2. Ausblick')
    expect(ev.location).toBe('Raum 4.12')
    expect(ev.start).toEqual({
      kind: 'datetime',
      tzid: 'Europe/Berlin',
      wall: { year: 2026, month: 10, day: 21, hour: 14, minute: 0, second: 0 },
    })
    expect(toInstant(ev.start).toISOString()).toBe('2026-10-21T12:00:00.000Z')
    expect(toInstant(ev.end).toISOString()).toBe('2026-10-21T13:30:00.000Z')
    expect(ev.organizer).toEqual({ name: 'Anna Müller', email: 'anna@contoso.com' })
    expect(ev.attendees).toEqual([
      {
        name: 'Benni',
        email: 'benni@example.org',
        partstat: 'NEEDS-ACTION',
        role: 'REQ-PARTICIPANT',
        rsvp: true,
      },
      {
        name: 'Doe, John',
        email: 'john@example.org',
        partstat: 'NEEDS-ACTION',
        role: 'OPT-PARTICIPANT',
        rsvp: true,
      },
    ])
    expect(ev.alarms).toEqual([15])
    expect(parsed.timezones['W. Europe Standard Time']).toContain('BEGIN:VTIMEZONE')
  })

  it('reads a Google all-day event and date values without VALUE=DATE', () => {
    const ev = parseIcs(GOOGLE_ALL_DAY).events[0]!
    expect(ev.start).toEqual({ kind: 'date', date: '2026-10-03' })
    expect(ev.end).toEqual({ kind: 'date', date: '2026-10-04' })
    const bare = parseIcs(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART:20261224\nSUMMARY:Heiligabend\nEND:VEVENT\nEND:VCALENDAR\n',
    ).events[0]!
    expect(bare.start).toEqual({ kind: 'date', date: '2026-12-24' })
    // no DTEND and no DURATION: one day
    expect(bare.end).toEqual({ kind: 'date', date: '2026-12-25' })
  })

  it('treats Outlook midnight-to-midnight events flagged all-day as all-day', () => {
    const ev = parseIcs(
      crlf([
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:allday-outlook',
        'DTSTART;TZID=W. Europe Standard Time:20261102T000000',
        'DTEND;TZID=W. Europe Standard Time:20261104T000000',
        'X-MICROSOFT-CDO-ALLDAYEVENT:TRUE',
        'SUMMARY:Messe',
        'END:VEVENT',
        'END:VCALENDAR',
      ]),
    ).events[0]!
    expect(ev.start).toEqual({ kind: 'date', date: '2026-11-02' })
    expect(ev.end).toEqual({ kind: 'date', date: '2026-11-04' })
  })

  it('tolerates lowercase names, LF line ends, DURATION, and missing DTEND', () => {
    const parsed = parseIcs(
      [
        'begin:vcalendar',
        'begin:vevent',
        'uid:lower',
        'dtstart:20261005T090000Z',
        'duration:PT1H30M',
        'organizer:MaIlTo:Boss@Example.org',
        'summary:klein',
        'end:vevent',
        'begin:vevent',
        'uid:zero',
        'dtstart:20261005T090000Z',
        'end:vevent',
        'end:vcalendar',
      ].join('\n'),
    )
    const [a, b] = parsed.events
    expect(a!.summary).toBe('klein')
    expect(a!.duration).toBe('PT1H30M')
    expect(toInstant(a!.end).toISOString()).toBe('2026-10-05T10:30:00.000Z')
    expect(a!.organizer?.email).toBe('Boss@Example.org')
    // a timed event without end lasts no time at all
    expect(toInstant(b!.end).getTime()).toBe(toInstant(b!.start).getTime())
  })

  it('treats TZIDs it cannot identify as floating time', () => {
    const ev = parseIcs(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:f\nDTSTART;TZID=Mars/Olympus_Mons:20261005T090000\nEND:VEVENT\nEND:VCALENDAR',
    ).events[0]!
    expect(ev.start).toEqual({
      kind: 'datetime',
      wall: { year: 2026, month: 10, day: 5, hour: 9, minute: 0, second: 0 },
    })
    // floating means this computer's wall clock (TZ=Europe/Berlin in this test)
    expect(toInstant(ev.start).toISOString()).toBe('2026-10-05T07:00:00.000Z')
  })

  it('identifies custom VTIMEZONEs by their rules', () => {
    const custom = crlf([
      'BEGIN:VCALENDAR',
      'BEGIN:VTIMEZONE',
      'TZID:Customized Time Zone',
      'BEGIN:STANDARD',
      'DTSTART:16010101T030000',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:16010101T020000',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0400',
      'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:custom',
      'DTSTART;TZID="Customized Time Zone":20261005T090000',
      'END:VEVENT',
      'END:VCALENDAR',
    ])
    const ev = parseIcs(custom).events[0]!
    expect(ev.start.kind === 'datetime' && ev.start.tzid).toBe('America/New_York')
    expect(toInstant(ev.start).toISOString()).toBe('2026-10-05T13:00:00.000Z')

    // Outlook's localized names list cities; the hint picks the matching zone
    const [vtz] = parseComponents(
      buildVtimezone(
        'Europe/Berlin',
        2026,
        '(UTC+01:00) Amsterdam, Berlin, Bern, Rom, Stockholm, Wien',
      ),
    )
    vtz!.props = vtz!.props.filter((p) => p.name !== 'X-LIC-LOCATION')
    expect(ianaForVtimezone(vtz!, 2026)).toBe('Europe/Amsterdam')
  })

  it('reads VALARM triggers as minutes before start', () => {
    const alarm = (trigger: string): number | null =>
      alarmMinutes(parseComponents(`BEGIN:VALARM\nACTION:DISPLAY\n${trigger}\nEND:VALARM`)[0]!)
    expect(alarm('TRIGGER:-PT15M')).toBe(15)
    expect(alarm('TRIGGER:-P1D')).toBe(1440)
    expect(alarm('TRIGGER:-PT1H30M')).toBe(90)
    expect(alarm('TRIGGER:PT0S')).toBe(0)
    expect(alarm('TRIGGER;VALUE=DATE-TIME:20261005T080000Z')).toBeNull()
    expect(alarm('TRIGGER;RELATED=END:-PT5M')).toBeNull()
    expect(alarm('TRIGGER:PT10M')).toBeNull()
    expect(parseDuration('P1W')).toBe(7 * 86400)
    expect(parseDuration('PT')).toBeNull()
    expect(parseDuration('nonsense')).toBeNull()
  })

  it('groups a series with its RECURRENCE-ID overrides', () => {
    const parsed = parseIcs(
      crlf([
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:series',
        'RECURRENCE-ID;TZID=Europe/Berlin:20261012T090000',
        'DTSTART;TZID=Europe/Berlin:20261012T110000',
        'DTEND;TZID=Europe/Berlin:20261012T120000',
        'SUMMARY:verschoben',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:series',
        'DTSTART;TZID=Europe/Berlin:20261005T090000',
        'DTEND;TZID=Europe/Berlin:20261005T100000',
        'RRULE:FREQ=WEEKLY',
        'SUMMARY:Jour fixe',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:other',
        'DTSTART:20261005T090000Z',
        'END:VEVENT',
        'END:VCALENDAR',
      ]),
    )
    const groups = groupByUid(parsed.events)
    expect(groups.map((g) => g.uid)).toEqual(['series', 'other'])
    expect(groups[0]!.master?.summary).toBe('Jour fixe')
    expect(groups[0]!.overrides.map((o) => o.summary)).toEqual(['verschoben'])
  })

  it('survives malformed input', () => {
    expect(parseIcs('').events).toEqual([])
    expect(parseIcs('this is not a calendar').events).toEqual([])
    const parsed = parseIcs(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:broken\nDTSTART:2026-13-45\nSUMMARY:kaputt\nEND:VEVENT\nBEGIN:VEVENT\nUID:ok\nDTSTART:20261005T090000Z\nEND:VCALENDAR',
    )
    expect(parsed.events.map((e) => e.uid)).toEqual(['broken', 'ok'])
    expect(parsed.events[0]!.timeless).toBe(true)
  })
})

describe('buildCalendarObject', () => {
  it('round-trips unknown properties and keeps unchanged lines verbatim', () => {
    const parsed = parseIcs(OUTLOOK_INVITE)
    const text = buildCalendarObject(parsed.events[0]!, [], { timezones: parsed.timezones })
    for (const line of [
      'CLASS:PUBLIC',
      'PRIORITY:5',
      'TRANSP:OPAQUE',
      'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE',
      'X-MICROSOFT-CDO-ALLDAYEVENT:FALSE',
      'DTSTART;TZID=W. Europe Standard Time:20261021T140000',
      'SUMMARY;LANGUAGE=de-DE:Quartalsplanung',
      'SEQUENCE:0',
      'DTSTAMP:20261001T080000Z',
      'TRIGGER;RELATED=START:-PT15M',
    ]) {
      expect(text).toContain(line)
    }
    expect(text).toContain('X-ALT-DESC;FMTTYPE=text/html:')
    expect(text).toContain('X-NUM-GUESTS=0')
    expect(text).toContain('PRODID:-//Suite Office//DE')
    expect(text).not.toContain('METHOD:')
    // the object's own VTIMEZONE is reused for its TZID
    expect(text).toContain('DTSTART:16010101T030000')

    const again = parseIcs(text).events[0]!
    const { raw: _a, origin: _b, ...fields } = again
    const { raw: _c, origin: _d, ...before } = parsed.events[0]!
    expect(fields).toEqual(before)
  })

  it('bumps SEQUENCE and rewrites times when the event moves', () => {
    const parsed = parseIcs(OUTLOOK_INVITE)
    const ev = parsed.events[0]!
    ev.start = {
      kind: 'datetime',
      tzid: 'Europe/Berlin',
      wall: { year: 2026, month: 10, day: 22, hour: 9, minute: 0, second: 0 },
    }
    ev.end = {
      kind: 'datetime',
      tzid: 'Europe/Berlin',
      wall: { year: 2026, month: 10, day: 22, hour: 10, minute: 0, second: 0 },
    }
    ev.description = 'Neue Agenda'
    const text = buildCalendarObject(ev, [], { timezones: parsed.timezones })
    expect(text).toContain('SEQUENCE:1')
    expect(text).toContain('DTSTART;TZID=Europe/Berlin:20261022T090000')
    expect(text).toContain('DTEND;TZID=Europe/Berlin:20261022T100000')
    // the stale HTML description goes, the LANGUAGE parameter stays
    expect(text).not.toContain('X-ALT-DESC')
    expect(text).toContain('DESCRIPTION;LANGUAGE=de-DE:Neue Agenda')
    // a generated VTIMEZONE for the IANA name, none for the unused Windows name
    expect(text).toContain('TZID:Europe/Berlin')
    expect(text).not.toContain('TZID:W. Europe Standard Time')
    expect(text).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU')
    expect(text).toContain('CLASS:PUBLIC')
  })

  it('changes only what changed on an attendee', () => {
    const parsed = parseIcs(OUTLOOK_INVITE)
    const ev = parsed.events[0]!
    ev.attendees[1] = { ...ev.attendees[1]!, partstat: 'ACCEPTED' }
    ev.attendees.push({
      email: 'new@example.org',
      name: 'Neu',
      partstat: 'NEEDS-ACTION',
      role: 'REQ-PARTICIPANT',
      rsvp: true,
    })
    const text = buildCalendarObject(ev, [], { timezones: parsed.timezones }).replace(/\r\n /g, '')
    expect(text).toContain(
      'ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE;CN="Doe, John";X-NUM-GUESTS=0:mailto:john@example.org',
    )
    expect(text).toContain(
      'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Neu:mailto:new@example.org',
    )
    expect(text).toContain('ORGANIZER;CN=Anna Müller:MAILTO:anna@contoso.com')
  })

  it('writes new events with TZID and VTIMEZONE, UTC as Z, all-day as DATE', () => {
    const berlin: EventTime = {
      kind: 'datetime',
      tzid: 'Europe/Berlin',
      wall: { year: 2026, month: 12, day: 1, hour: 9, minute: 30, second: 0 },
    }
    const ev = newEvent('new@suite-office', berlin, {
      ...berlin,
      wall: { ...berlin.wall, hour: 10 },
    })
    ev.summary = 'Planung; Budget, 2027 \\ Q1'
    ev.alarms = [10, 1440]
    const text = buildCalendarObject(ev, [])
    expect(
      text.startsWith(
        'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Suite Office//DE\r\nCALSCALE:GREGORIAN',
      ),
    ).toBe(true)
    expect(text).toMatch(/DTSTAMP:\d{8}T\d{6}Z/)
    expect(text).toContain('DTSTART;TZID=Europe/Berlin:20261201T093000')
    expect(text).toContain('BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin')
    expect(text).toContain('SUMMARY:Planung\\; Budget\\, 2027 \\\\ Q1')
    expect(text).toContain('TRIGGER:-PT10M')
    expect(text).toContain('TRIGGER:-P1D')
    expect(parseIcs(text).events[0]!.summary).toBe('Planung; Budget, 2027 \\ Q1')

    const utc = newEvent(
      'utc',
      { kind: 'datetime', utc: true, wall: berlin.wall },
      { kind: 'datetime', utc: true, wall: berlin.wall },
    )
    const utcText = buildCalendarObject(utc, [])
    expect(utcText).toContain('DTSTART:20261201T093000Z')
    expect(utcText).not.toContain('VTIMEZONE')

    const day = newEvent(
      'day',
      { kind: 'date', date: '2026-12-24' },
      { kind: 'date', date: '2026-12-25' },
    )
    expect(buildCalendarObject(day, [])).toContain('DTSTART;VALUE=DATE:20261224')
  })

  it('leaves alarms and scheduling hints out of iTIP messages', () => {
    const parsed = parseIcs(OUTLOOK_INVITE)
    const stored = buildCalendarObject(parsed.events[0]!, [], {
      timezones: parsed.timezones,
      scheduleAgentClient: true,
    })
    expect(stored).toContain('SCHEDULE-AGENT=CLIENT')
    const reparsed = parseIcs(stored)
    const request = buildCalendarObject(reparsed.events[0]!, [], {
      method: 'REQUEST',
      timezones: reparsed.timezones,
    })
    expect(request).toContain('METHOD:REQUEST')
    expect(request).not.toContain('VALARM')
    expect(request).not.toContain('SCHEDULE-AGENT')
  })

  it('folds long lines and keeps UTF-8 intact', () => {
    const ev = newEvent(
      'fold',
      { kind: 'date', date: '2026-10-01' },
      { kind: 'date', date: '2026-10-02' },
    )
    ev.description = 'Ümläüte '.repeat(40)
    const text = buildCalendarObject(ev, [])
    for (const line of text.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    expect(parseIcs(text).events[0]!.description).toBe(ev.description)
  })

  it('derives an occurrence override that carries the series properties', () => {
    const parsed = parseIcs(
      crlf([
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:weekly',
        'DTSTART;TZID=Europe/Berlin:20261005T090000',
        'DTEND;TZID=Europe/Berlin:20261005T100000',
        'RRULE:FREQ=WEEKLY',
        'EXDATE;TZID=Europe/Berlin:20261019T090000',
        'SUMMARY:Jour fixe',
        'CATEGORIES:Team',
        'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
        'END:VEVENT',
        'END:VCALENDAR',
      ]),
    )
    const master = parsed.events[0]!
    const at = (day: number, hour: number): EventTime => ({
      kind: 'datetime',
      tzid: 'Europe/Berlin',
      wall: { year: 2026, month: 10, day, hour, minute: 0, second: 0 },
    })
    const rid = at(12, 9)
    const ov = deriveOccurrence(master, rid, rid, at(12, 10))
    ov.summary = 'Jour fixe (Raum 2)'
    const text = buildCalendarObject(master, [ov], { timezones: parsed.timezones })
    const events = parseIcs(text).events
    expect(events).toHaveLength(2)
    const override = events[1]!
    expect(override.recurrenceId).toEqual(rid)
    expect(override.rrule).toBeUndefined()
    expect(override.exdates).toEqual([])
    expect(text.split('CATEGORIES:Team').length).toBe(3)
    expect(text.split('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC').length).toBe(3)
    expect(override.summary).toBe('Jour fixe (Raum 2)')
  })
})

describe('buildVtimezone', () => {
  const block = (zone: string): string => buildVtimezone(zone, 2026)

  it('describes Europe/Berlin with last-Sunday rules', () => {
    const text = block('Europe/Berlin')
    expect(text).toContain(
      'BEGIN:DAYLIGHT\r\nDTSTART:19700329T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nTZNAME:CEST',
    )
    expect(text).toContain(
      'BEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nTZNAME:CET',
    )
    const [first, second] = zoneTransitions('Europe/Berlin', 2026)
    expect(new Date(first!.at).toISOString()).toBe('2026-03-29T01:00:00.000Z')
    expect(new Date(second!.at).toISOString()).toBe('2026-10-25T01:00:00.000Z')
  })

  it('describes America/New_York with n-th Sunday rules', () => {
    const text = block('America/New_York')
    expect(text).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU')
    expect(text).toContain('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU')
    expect(text).toContain('TZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400')
  })

  it('gives zones without DST a single STANDARD block', () => {
    const text = block('Asia/Tokyo')
    expect(text).toContain('TZOFFSETFROM:+0900\r\nTZOFFSETTO:+0900')
    expect(text).not.toContain('DAYLIGHT')
    expect(text).not.toContain('RRULE')
  })

  it('handles the southern hemisphere (Australia/Sydney)', () => {
    const text = block('Australia/Sydney')
    expect(text).toContain(
      'BEGIN:STANDARD\r\nDTSTART:19700405T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU\r\nTZOFFSETFROM:+1100\r\nTZOFFSETTO:+1000',
    )
    expect(text).toContain(
      'BEGIN:DAYLIGHT\r\nDTSTART:19701004T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU\r\nTZOFFSETFROM:+1000\r\nTZOFFSETTO:+1100',
    )
  })

  it('produces blocks that read back as the same zone', () => {
    for (const zone of ['Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Australia/Sydney']) {
      const [vtz] = parseComponents(buildVtimezone(zone, 2026, 'Irgendwas'))
      // X-LIC-LOCATION answers directly; without it, the rules must match
      vtz!.props = vtz!.props.filter((p) => p.name !== 'X-LIC-LOCATION')
      const found = ianaForVtimezone(vtz!, 2026)
      expect(found).toBeTruthy()
      for (const month of [0, 3, 6, 9]) {
        const at = new Date(Date.UTC(2026, month, 10, 12))
        const offset = (z: string): string =>
          new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'longOffset' }).format(at)
        expect(offset(found!)).toBe(offset(zone))
      }
    }
  })
})
