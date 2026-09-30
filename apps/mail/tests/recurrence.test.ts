import { describe, expect, it } from 'vitest'
import { groupByUid, parseIcs, type EventTime, type VEvent } from '../src/main/pim/ics'
import {
  MAX_OCCURRENCES,
  expandOccurrences,
  findOccurrence,
  generates,
  matchesOccurrence,
  occurrenceKey,
  parseRule,
} from '../src/main/pim/recurrence'

process.env.TZ = 'Europe/Berlin'

function series(lines: string[]): { master: VEvent; overrides: VEvent[] } {
  const text = ['BEGIN:VCALENDAR', ...lines, 'END:VCALENDAR'].join('\r\n')
  const [group] = groupByUid(parseIcs(text).events)
  return { master: group!.master!, overrides: group!.overrides }
}

function event(props: string[]): string[] {
  return ['BEGIN:VEVENT', 'UID:s', ...props, 'END:VEVENT']
}

const iso = (d: Date): string => d.toISOString()
const range = (from: string, to: string): [Date, Date] => [new Date(from), new Date(to)]

describe('expandOccurrences', () => {
  it('keeps a weekly 09:00 Europe/Berlin meeting at 09:00 across DST', () => {
    const { master } = series(
      event([
        'DTSTART;TZID=Europe/Berlin:20261012T090000',
        'DTEND;TZID=Europe/Berlin:20261012T100000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
      ]),
    )
    const list = expandOccurrences(
      master,
      [],
      ...range('2026-10-12T00:00:00Z', '2026-11-10T00:00:00Z'),
    )
    expect(list.map((o) => iso(o.startAt))).toEqual([
      '2026-10-12T07:00:00.000Z',
      '2026-10-19T07:00:00.000Z',
      // Oct 25: back to CET
      '2026-10-26T08:00:00.000Z',
      '2026-11-02T08:00:00.000Z',
      '2026-11-09T08:00:00.000Z',
    ])
    expect(list.every((o) => o.end.kind === 'datetime' && o.end.wall.hour === 10)).toBe(true)
    expect(list[2]!.recurrenceId).toEqual({
      kind: 'datetime',
      tzid: 'Europe/Berlin',
      wall: { year: 2026, month: 10, day: 26, hour: 9, minute: 0, second: 0 },
    })
  })

  it('applies EXDATE and a moved occurrence', () => {
    const { master, overrides } = series([
      ...event([
        'DTSTART;TZID=Europe/Berlin:20261005T090000',
        'DTEND;TZID=Europe/Berlin:20261005T100000',
        'RRULE:FREQ=WEEKLY;COUNT=6',
        'EXDATE;TZID=Europe/Berlin:20261019T090000',
        'SUMMARY:Jour fixe',
      ]),
      ...event([
        'RECURRENCE-ID;TZID=Europe/Berlin:20261012T090000',
        'DTSTART;TZID=Europe/Berlin:20261013T140000',
        'DTEND;TZID=Europe/Berlin:20261013T150000',
        'SUMMARY:Jour fixe (Dienstag)',
      ]),
    ])
    const list = expandOccurrences(
      master,
      overrides,
      ...range('2026-10-01T00:00:00Z', '2027-01-01T00:00:00Z'),
    )
    expect(list.map((o) => [iso(o.startAt), o.event.summary, o.override])).toEqual([
      ['2026-10-05T07:00:00.000Z', 'Jour fixe', false],
      ['2026-10-13T12:00:00.000Z', 'Jour fixe (Dienstag)', true],
      ['2026-10-26T08:00:00.000Z', 'Jour fixe', false],
      ['2026-11-02T08:00:00.000Z', 'Jour fixe', false],
      ['2026-11-09T08:00:00.000Z', 'Jour fixe', false],
    ])
    // the moved occurrence still names its original slot
    expect(occurrenceKey(list[1]!.recurrenceId!)).toBe('2026-10-12T07:00:00.000Z')
  })

  it('finds a moved occurrence even when only its new time is in range', () => {
    const { master, overrides } = series([
      ...event(['DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z', 'RRULE:FREQ=DAILY;COUNT=3']),
      ...event([
        'RECURRENCE-ID:20261006T090000Z',
        'DTSTART:20261120T090000Z',
        'DTEND:20261120T100000Z',
      ]),
    ])
    const november = expandOccurrences(
      master,
      overrides,
      ...range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'),
    )
    expect(november.map((o) => iso(o.startAt))).toEqual(['2026-11-20T09:00:00.000Z'])
    const october = expandOccurrences(
      master,
      overrides,
      ...range('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'),
    )
    expect(october.map((o) => iso(o.startAt))).toEqual([
      '2026-10-05T09:00:00.000Z',
      '2026-10-07T09:00:00.000Z',
    ])
  })

  it('treats an override whose RECURRENCE-ID is excluded as deleted', () => {
    const { master, overrides } = series([
      ...event(['DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE:20261006T090000Z']),
      ...event(['RECURRENCE-ID:20261006T090000Z', 'DTSTART:20261006T120000Z']),
    ])
    const list = expandOccurrences(
      master,
      overrides,
      ...range('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'),
    )
    expect(list.map((o) => iso(o.startAt))).toEqual([
      '2026-10-05T09:00:00.000Z',
      '2026-10-07T09:00:00.000Z',
    ])
  })

  it('honours UNTIL in UTC and as a date', () => {
    const utc = series(
      event([
        'DTSTART;TZID=Europe/Berlin:20261005T090000',
        'RRULE:FREQ=DAILY;UNTIL=20261007T070000Z',
      ]),
    ).master
    expect(
      expandOccurrences(utc, [], ...range('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')).map(
        (o) => iso(o.startAt),
      ),
    ).toEqual(['2026-10-05T07:00:00.000Z', '2026-10-06T07:00:00.000Z', '2026-10-07T07:00:00.000Z'])

    const byDate = series(
      event(['DTSTART;TZID=Europe/Berlin:20261005T090000', 'RRULE:FREQ=DAILY;UNTIL=20261006']),
    ).master
    expect(
      expandOccurrences(byDate, [], ...range('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')),
    ).toHaveLength(2)

    // Apple writes all-day UNTIL as the UTC instant of local midnight
    const apple = series(
      event([
        'DTSTART;VALUE=DATE:20261228',
        'DTEND;VALUE=DATE:20261229',
        'RRULE:FREQ=DAILY;UNTIL=20261230T230000Z',
      ]),
    ).master
    expect(
      expandOccurrences(apple, [], ...range('2026-12-01T00:00:00Z', '2027-02-01T00:00:00Z')).map(
        (o) => o.start.kind === 'date' && o.start.date,
      ),
    ).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31'])
  })

  it('expands all-day series in dates and adds RDATEs', () => {
    const { master } = series(
      event([
        'DTSTART;VALUE=DATE:19800315',
        'DTEND;VALUE=DATE:19800316',
        'RRULE:FREQ=YEARLY',
        'RDATE;VALUE=DATE:20270101',
        'EXDATE;VALUE=DATE:20280315',
        'SUMMARY:Geburtstag',
      ]),
    )
    const list = expandOccurrences(
      master,
      [],
      ...range('2026-01-01T00:00:00Z', '2029-01-01T00:00:00Z'),
    )
    expect(list.map((o) => (o.start as { date: string }).date)).toEqual([
      '2026-03-15',
      '2027-01-01',
      '2027-03-15',
    ])
    expect(list[0]!.end).toEqual({ kind: 'date', date: '2026-03-16' })
    // all-day occurrences start at this computer's midnight
    expect(iso(list[0]!.startAt)).toBe('2026-03-14T23:00:00.000Z')
  })

  it('returns single events only when they overlap the range', () => {
    const { master } = series(event(['DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z']))
    expect(
      expandOccurrences(master, [], ...range('2026-10-05T09:30:00Z', '2026-10-05T12:00:00Z')),
    ).toHaveLength(1)
    expect(
      expandOccurrences(master, [], ...range('2026-10-05T10:00:00Z', '2026-10-05T12:00:00Z')),
    ).toHaveLength(0)
    expect(
      expandOccurrences(master, [], ...range('2026-10-05T07:00:00Z', '2026-10-05T09:00:00Z')),
    ).toHaveLength(0)
    const zero = series(event(['DTSTART:20261005T090000Z'])).master
    expect(
      expandOccurrences(zero, [], ...range('2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z')),
    ).toHaveLength(1)
  })

  it('includes DTSTART even when the rule would not produce it', () => {
    const { master } = series(
      // a Wednesday start for a Monday rule
      event(['DTSTART:20261007T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3']),
    )
    const list = expandOccurrences(
      master,
      [],
      ...range('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z'),
    )
    expect(list[0]!.startAt.toISOString()).toBe('2026-10-07T09:00:00.000Z')
    expect(list[1]!.startAt.toISOString()).toBe('2026-10-12T09:00:00.000Z')
  })

  it('caps the number of occurrences', () => {
    const { master } = series(event(['DTSTART:20000101T090000Z', 'RRULE:FREQ=DAILY']))
    const list = expandOccurrences(
      master,
      [],
      ...range('2000-01-01T00:00:00Z', '2040-01-01T00:00:00Z'),
    )
    expect(list).toHaveLength(MAX_OCCURRENCES)
  })

  it('expands old open-ended hourly rules quickly and correctly', () => {
    const { master } = series(
      event(['DTSTART:20000103T000000Z', 'DTEND:20000103T001500Z', 'RRULE:FREQ=HOURLY;INTERVAL=5']),
    )
    const started = Date.now()
    const list = expandOccurrences(
      master,
      [],
      ...range('2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z'),
    )
    expect(Date.now() - started).toBeLessThan(1000)
    const hours =
      (Date.parse('2026-10-05T00:00:00Z') - Date.parse('2000-01-03T00:00:00Z')) / 3600_000
    const first = Math.ceil(hours / 5) * 5
    expect(list[0]!.startAt.getTime()).toBe(Date.parse('2000-01-03T00:00:00Z') + first * 3600_000)
    expect(
      list.every(
        (o) => (o.startAt.getTime() - Date.parse('2000-01-03T00:00:00Z')) % (5 * 3600_000) === 0,
      ),
    ).toBe(true)
    expect(list.length).toBeGreaterThanOrEqual(4)
  })

  it('tolerates rules with unknown or broken parts', () => {
    const odd = series(
      event([
        'DTSTART:20261005T090000Z',
        'RRULE:freq=weekly;x-name=1;RSCALE=GREGORIAN;BYDAY=MO,,XX;COUNT=2',
      ]),
    ).master
    expect(
      expandOccurrences(odd, [], ...range('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z')),
    ).toHaveLength(2)
    const noFreq = series(event(['DTSTART:20261005T090000Z', 'RRULE:COUNT=5'])).master
    expect(
      expandOccurrences(noFreq, [], ...range('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z')),
    ).toHaveLength(1)
    // February 30th never comes; this must not search until the year 9999
    const never = series(
      event(['DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30']),
    ).master
    const started = Date.now()
    expect(
      expandOccurrences(never, [], ...range('2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z')),
    ).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(500)
    expect(
      parseRule('FREQ=MONTHLY;BYDAY=-1FR', { kind: 'date', date: '2026-01-30' })?.options.freq,
    ).toBe(1)
  })

  it('shows floating times on this computer’s clock', () => {
    const { master } = series(event(['DTSTART:20261005T090000', 'RRULE:FREQ=DAILY;COUNT=2']))
    const list = expandOccurrences(
      master,
      [],
      ...range('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'),
    )
    expect(list.map((o) => iso(o.startAt))).toEqual([
      '2026-10-05T07:00:00.000Z',
      '2026-10-06T07:00:00.000Z',
    ])
  })
})

describe('occurrence keys', () => {
  const berlin9: EventTime = {
    kind: 'datetime',
    tzid: 'Europe/Berlin',
    wall: { year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0 },
  }

  it('match instants and dates', () => {
    expect(occurrenceKey(berlin9)).toBe('2026-10-12T07:00:00.000Z')
    expect(occurrenceKey({ kind: 'date', date: '2026-10-12' })).toBe('2026-10-12')
    expect(matchesOccurrence(berlin9, '2026-10-12T07:00:00.000Z')).toBe(true)
    expect(matchesOccurrence(berlin9, '2026-10-12T07:00:00Z')).toBe(true)
    expect(matchesOccurrence(berlin9, '2026-10-12T08:00:00.000Z')).toBe(false)
    expect(matchesOccurrence({ kind: 'date', date: '2026-10-12' }, '2026-10-12')).toBe(true)
    expect(matchesOccurrence(berlin9, '2026-10-12')).toBe(true)
    expect(matchesOccurrence(berlin9, 'garbage')).toBe(false)
  })

  it('find an occurrence and tell which instances a rule produces', () => {
    const { master } = series(
      event([
        'DTSTART;TZID=Europe/Berlin:20261005T090000',
        'DTEND;TZID=Europe/Berlin:20261005T100000',
        'RRULE:FREQ=WEEKLY;COUNT=4',
        'EXDATE;TZID=Europe/Berlin:20261019T090000',
      ]),
    )
    expect(findOccurrence(master, [], '2026-10-12T07:00:00.000Z')?.startAt.toISOString()).toBe(
      '2026-10-12T07:00:00.000Z',
    )
    expect(findOccurrence(master, [], '2026-10-19T07:00:00.000Z')).toBeNull()
    expect(findOccurrence(master, [], '2026-10-13T07:00:00.000Z')).toBeNull()
    // generates() ignores EXDATEs: the instance exists in the rule
    expect(generates(master, { ...berlin9, wall: { ...berlin9.wall, day: 19 } })).toBe(true)
    expect(generates(master, { ...berlin9, wall: { ...berlin9.wall, day: 20 } })).toBe(false)
    expect(generates(master, { ...berlin9, wall: { ...berlin9.wall, month: 11, day: 2 } })).toBe(
      false,
    )
  })
})
