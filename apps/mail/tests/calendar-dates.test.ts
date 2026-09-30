// Every expectation below is for Europe/Berlin (CET/CEST): DST starts on
// 29 Mar 2026 (02:00 → 03:00) and ends on 25 Oct 2026 (03:00 → 02:00).
process.env.TZ = 'Europe/Berlin'

import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  buildRrule,
  combineLocal,
  dayCells,
  dayKey,
  daysBetween,
  eventSpan,
  formatEventWhen,
  formatHour,
  formatTime,
  fromIso,
  isLongEvent,
  isValidDate,
  minutesOfDay,
  monthGrid,
  noRepeat,
  overlapsDay,
  parseDayKey,
  parseRrule,
  periodTitle,
  repeatProblem,
  shiftAnchor,
  startOfDay,
  startOfWeek,
  timeKey,
  toIso,
  viewRange,
  weekdayNames,
  weekOrder,
  weekStartsOn,
  type RepeatRule,
} from '../src/renderer/calendar/dates'

const HOUR = 3_600_000
const d = (y: number, m: number, day: number, h = 0, min = 0): Date =>
  new Date(y, m - 1, day, h, min)

describe('time zone of this test file', () => {
  it('runs in Europe/Berlin', () => {
    expect(d(2026, 7, 1).getTimezoneOffset()).toBe(-120)
    expect(d(2026, 12, 1).getTimezoneOffset()).toBe(-60)
  })
})

describe('weekStartsOn', () => {
  it('starts on Monday for German and most languages', () => {
    for (const lang of ['de', 'de-DE', 'de-AT', 'fr', 'es', 'it', 'nl', 'pl', 'en-GB', 'zh'])
      expect(weekStartsOn(lang)).toBe(1)
  })

  it('starts on Sunday for English and other Sunday regions', () => {
    for (const lang of ['en', 'en-US', 'en_US', 'pt-BR', 'ja', 'he'])
      expect(weekStartsOn(lang)).toBe(0)
  })

  it('starts on Saturday where the week does', () => {
    expect(weekStartsOn('ar')).toBe(6)
    expect(weekStartsOn('ar-EG')).toBe(6)
    // the region decides over the language
    expect(weekStartsOn('ar-MA')).toBe(1)
  })
})

describe('local-day math across DST', () => {
  it('adds calendar days, not 24-hour blocks, over the spring change', () => {
    const sat = d(2026, 3, 28)
    const sun = addDays(sat, 1)
    const mon = addDays(sat, 2)
    expect(dayKey(sun)).toBe('2026-03-29')
    expect(dayKey(mon)).toBe('2026-03-30')
    expect(mon.getHours()).toBe(0)
    // the Sunday has only 23 hours
    expect(mon.getTime() - sun.getTime()).toBe(23 * HOUR)
    expect(daysBetween(sat, mon)).toBe(2)
  })

  it('adds calendar days over the autumn change', () => {
    const sun = d(2026, 10, 25)
    const mon = addDays(sun, 1)
    expect(dayKey(mon)).toBe('2026-10-26')
    expect(mon.getHours()).toBe(0)
    expect(mon.getTime() - sun.getTime()).toBe(25 * HOUR)
    expect(daysBetween(sun, mon)).toBe(1)
    expect(daysBetween(mon, sun)).toBe(-1)
  })

  it('keeps the wall-clock time when adding days', () => {
    const before = d(2026, 3, 28, 9, 30)
    const after = addDays(before, 2)
    expect(timeKey(after)).toBe('09:30')
    expect(dayKey(after)).toBe('2026-03-30')
  })

  it('clamps addMonths to shorter months', () => {
    expect(dayKey(addMonths(d(2026, 1, 31), 1))).toBe('2026-02-28')
    expect(dayKey(addMonths(d(2028, 1, 31), 1))).toBe('2028-02-29')
    expect(dayKey(addMonths(d(2026, 3, 31), -1))).toBe('2026-02-28')
    expect(dayKey(addMonths(d(2026, 11, 15), 3))).toBe('2027-02-15')
  })

  it('measures minutes on the wall clock on DST days', () => {
    expect(minutesOfDay(d(2026, 3, 29, 12))).toBe(720)
    expect(minutesOfDay(d(2026, 10, 25, 12))).toBe(720)
  })

  it('finds the start of the week for either convention', () => {
    const wed = d(2026, 9, 30)
    expect(dayKey(startOfWeek(wed, 1))).toBe('2026-09-28')
    expect(dayKey(startOfWeek(wed, 0))).toBe('2026-09-27')
    expect(dayKey(startOfWeek(d(2026, 9, 28), 1))).toBe('2026-09-28')
    expect(dayKey(startOfWeek(d(2026, 10, 4), 1))).toBe('2026-09-28')
  })
})

describe('parsing and the IPC form', () => {
  it('turns date keys into local midnight and rejects impossible dates', () => {
    const day = parseDayKey('2026-10-01')
    expect([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours()]).toEqual([
      2026, 9, 1, 0,
    ])
    expect(isValidDate(parseDayKey('2026-02-31'))).toBe(false)
    expect(isValidDate(parseDayKey('1.10.2026'))).toBe(false)
    expect(isValidDate(parseDayKey(''))).toBe(false)
  })

  it('combines date and time fields, moving a skipped hour forward', () => {
    expect(combineLocal('2026-10-01', '09:15').toISOString()).toBe('2026-10-01T07:15:00.000Z')
    const skipped = combineLocal('2026-03-29', '02:30')
    expect(isValidDate(skipped)).toBe(true)
    expect(skipped.getHours()).toBe(3)
    expect(isValidDate(combineLocal('2026-10-01', ''))).toBe(false)
    expect(isValidDate(combineLocal('', '09:00'))).toBe(false)
  })

  it('writes dates for all-day events and instants for timed ones', () => {
    expect(toIso(d(2026, 10, 1), true)).toBe('2026-10-01')
    expect(toIso(d(2026, 10, 1, 9), false)).toBe('2026-10-01T07:00:00.000Z')
    expect(toIso(d(2026, 12, 1, 9), false)).toBe('2026-12-01T08:00:00.000Z')
  })

  it('reads both forms back', () => {
    const date = fromIso('2026-10-01')
    expect(date.getHours()).toBe(0)
    expect(date.getDate()).toBe(1)
    expect(fromIso('2026-10-01T07:00:00Z').getHours()).toBe(9)
    expect(isValidDate(fromIso(undefined))).toBe(false)
    expect(isValidDate(fromIso('garbage'))).toBe(false)
  })
})

describe('eventSpan and day membership', () => {
  it('repairs missing or inverted ends', () => {
    const allDay = eventSpan({ start: '2026-10-01', end: '', allDay: true })
    expect(dayKey(allDay.end)).toBe('2026-10-02')
    const sameDay = eventSpan({ start: '2026-10-01', end: '2026-10-01', allDay: true })
    expect(dayKey(sameDay.end)).toBe('2026-10-02')
    const timed = eventSpan({
      start: '2026-10-01T08:00:00Z',
      end: '2026-10-01T07:00:00Z',
      allDay: false,
    })
    expect(timed.end.getTime()).toBe(timed.start.getTime())
  })

  it('puts an event crossing midnight on both days', () => {
    const span = eventSpan({
      start: d(2026, 10, 1, 23).toISOString(),
      end: d(2026, 10, 2, 1).toISOString(),
      allDay: false,
    })
    expect(overlapsDay(span, d(2026, 10, 1))).toBe(true)
    expect(overlapsDay(span, d(2026, 10, 2))).toBe(true)
    expect(overlapsDay(span, d(2026, 10, 3))).toBe(false)
  })

  it('does not spill an event ending at midnight into the next day', () => {
    const span = eventSpan({
      start: d(2026, 10, 1, 22).toISOString(),
      end: d(2026, 10, 2).toISOString(),
      allDay: false,
    })
    expect(overlapsDay(span, d(2026, 10, 2))).toBe(false)
    const zero = eventSpan({
      start: d(2026, 10, 2).toISOString(),
      end: d(2026, 10, 2).toISOString(),
      allDay: false,
    })
    expect(overlapsDay(zero, d(2026, 10, 2))).toBe(true)
    expect(overlapsDay(zero, d(2026, 10, 1))).toBe(false)
  })

  it('treats a whole DST day as long enough for the all-day lane', () => {
    const autumn = eventSpan({
      start: d(2026, 10, 25).toISOString(),
      end: d(2026, 10, 26).toISOString(),
      allDay: false,
    })
    expect(isLongEvent(autumn)).toBe(true)
    const short = eventSpan({
      start: d(2026, 10, 1, 1).toISOString(),
      end: d(2026, 10, 2, 0).toISOString(),
      allDay: false,
    })
    expect(isLongEvent(short)).toBe(false)
    expect(isLongEvent(eventSpan({ start: '2026-10-01', end: '2026-10-02', allDay: true }))).toBe(
      true,
    )
  })

  it('maps events onto day cells, clipped to the row', () => {
    const monday = d(2026, 9, 28)
    const allDay = eventSpan({ start: '2026-10-01', end: '2026-10-03', allDay: true })
    expect(dayCells(allDay, monday, 7)).toEqual({
      start: 3,
      end: 5,
      clippedStart: false,
      clippedEnd: false,
    })
    const timed = eventSpan({
      start: d(2026, 9, 30, 10).toISOString(),
      end: d(2026, 10, 2, 9).toISOString(),
      allDay: false,
    })
    expect(dayCells(timed, monday, 7)).toMatchObject({ start: 2, end: 5 })
    const long = eventSpan({ start: '2026-09-20', end: '2026-10-10', allDay: true })
    expect(dayCells(long, monday, 7)).toEqual({
      start: 0,
      end: 7,
      clippedStart: true,
      clippedEnd: true,
    })
    const outside = eventSpan({ start: '2026-10-05', end: '2026-10-06', allDay: true })
    expect(dayCells(outside, monday, 7)).toBeNull()
  })

  it('counts the cells of an all-day event over the DST change', () => {
    const monday = d(2026, 10, 19)
    const span = eventSpan({ start: '2026-10-24', end: '2026-10-27', allDay: true })
    expect(dayCells(span, monday, 7)).toMatchObject({ start: 5, end: 7, clippedEnd: true })
  })
})

describe('view ranges', () => {
  it('is one day for the day view, even a 25-hour one', () => {
    const r = viewRange('day', d(2026, 10, 25, 15), 1)
    expect(r.days.map(dayKey)).toEqual(['2026-10-25'])
    expect(dayKey(r.end)).toBe('2026-10-26')
    expect(r.end.getTime() - r.start.getTime()).toBe(25 * HOUR)
  })

  it('shows Monday to Friday in the work week', () => {
    const r = viewRange('workweek', d(2026, 9, 30), 1)
    expect(r.days.map(dayKey)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ])
    expect(dayKey(r.end)).toBe('2026-10-03')
  })

  it('picks the work week of the locale’s week for a Sunday', () => {
    const sunday = d(2026, 10, 4)
    // Monday weeks: the Sunday ends the week of 28 Sep
    expect(dayKey(viewRange('workweek', sunday, 1).start)).toBe('2026-09-28')
    // Sunday weeks: the Sunday starts the week of 5 Oct
    expect(dayKey(viewRange('workweek', sunday, 0).start)).toBe('2026-10-05')
  })

  it('covers seven midnights in a DST week', () => {
    const r = viewRange('week', d(2026, 3, 26), 1)
    expect(r.days.map(dayKey)).toEqual([
      '2026-03-23',
      '2026-03-24',
      '2026-03-25',
      '2026-03-26',
      '2026-03-27',
      '2026-03-28',
      '2026-03-29',
    ])
    expect(r.days.every((day) => day.getHours() === 0)).toBe(true)
    expect(r.end.getTime() - r.start.getTime()).toBe(7 * 24 * HOUR - HOUR)
  })

  it('fills whole weeks around a month', () => {
    const oct = viewRange('month', d(2026, 10, 14), 1)
    expect(dayKey(oct.start)).toBe('2026-09-28')
    expect(dayKey(oct.end)).toBe('2026-11-02')
    expect(oct.days).toHaveLength(35)
    expect(oct.days.every((day) => day.getHours() === 0)).toBe(true)

    const octUs = viewRange('month', d(2026, 10, 14), 0)
    expect(dayKey(octUs.start)).toBe('2026-09-27')
    expect(octUs.days).toHaveLength(35)

    // February 2027 starts on a Monday and has exactly four weeks
    expect(viewRange('month', d(2027, 2, 10), 1).days).toHaveLength(28)
    // August 2026 needs six rows with Monday weeks
    expect(viewRange('month', d(2026, 8, 10), 1).days).toHaveLength(42)
  })

  it('looks 60 days ahead in the agenda', () => {
    const r = viewRange('agenda', d(2026, 9, 30, 14), 1)
    expect(r.days).toHaveLength(60)
    expect(dayKey(r.start)).toBe('2026-09-30')
    expect(dayKey(r.end)).toBe('2026-11-29')
  })

  it('always shows six weeks in the mini month', () => {
    const grid = monthGrid(d(2026, 10, 20), 1)
    expect(grid).toHaveLength(42)
    expect(dayKey(grid[0]!)).toBe('2026-09-28')
    expect(grid[0]!.getDay()).toBe(1)
  })

  it('moves the anchor by one period', () => {
    const wed = d(2026, 9, 30)
    expect(dayKey(shiftAnchor('day', wed, 1))).toBe('2026-10-01')
    expect(dayKey(shiftAnchor('week', wed, -1))).toBe('2026-09-23')
    expect(dayKey(shiftAnchor('workweek', wed, 1))).toBe('2026-10-07')
    expect(dayKey(shiftAnchor('month', d(2026, 1, 31), 1))).toBe('2026-02-01')
    expect(dayKey(shiftAnchor('agenda', wed, 1))).toBe('2026-11-29')
    expect(dayKey(shiftAnchor('week', d(2026, 10, 21), 1))).toBe('2026-10-28')
  })
})

describe('formatting', () => {
  it('writes times like Outlook in 24- and 12-hour locales', () => {
    expect(formatTime(d(2026, 9, 30, 9, 5), 'de')).toBe('09:05')
    expect(formatTime(d(2026, 9, 30, 9, 5), 'en')).toMatch(/^9:05\sAM$/)
    expect(formatHour(9, 'de')).toBe('09:00')
    expect(formatHour(15, 'en')).toMatch(/^3\sPM$/)
  })

  it('titles each view', () => {
    const wed = d(2026, 9, 30)
    expect(periodTitle('month', wed, 1, 'de')).toBe('September 2026')
    expect(periodTitle('month', d(2026, 10, 3), 1, 'en')).toBe('October 2026')
    expect(periodTitle('day', wed, 1, 'de')).toBe('Mittwoch, 30. September 2026')
    const week = periodTitle('week', wed, 1, 'de')
    expect(week).toMatch(/^28\.\sSept?\.?\s–\s4\.\sOkt\.?\s2026$/)
    expect(periodTitle('workweek', wed, 1, 'en')).toMatch(/^Sep 28\s?–\s?Oct 2, 2026$/)
  })

  it('does not crash on an unknown language tag', () => {
    expect(() => formatTime(d(2026, 9, 30, 9), 'xx-invalid-tag!!')).not.toThrow()
  })

  it('names weekdays by Date#getDay and orders them by the week start', () => {
    expect(weekdayNames('de', 'long')[1]).toBe('Montag')
    expect(weekdayNames('en', 'long')[0]).toBe('Sunday')
    expect(weekOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0])
    expect(weekOrder(0)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('describes when an event happens', () => {
    const oneDay = eventSpan({ start: '2026-10-01', end: '2026-10-02', allDay: true })
    expect(formatEventWhen(oneDay, 'de')).toBe('Donnerstag, 1. Oktober 2026')
    const timed = eventSpan({
      start: d(2026, 10, 1, 9).toISOString(),
      end: d(2026, 10, 1, 10, 30).toISOString(),
      allDay: false,
    })
    const text = formatEventWhen(timed, 'de')
    expect(text).toContain('09:00')
    expect(text).toContain('10:30')
    expect(text).toContain('2026')
    const days = eventSpan({ start: '2026-10-01', end: '2026-10-04', allDay: true })
    expect(formatEventWhen(days, 'en')).toMatch(/Oct 1.*3/)
  })
})

describe('recurrence presets', () => {
  const wed = d(2026, 9, 30, 9)

  it('reads the rules the presets can express', () => {
    expect(parseRrule(undefined, wed)).toEqual(noRepeat())
    expect(parseRrule('', wed).kind).toBe('none')
    expect(parseRrule('FREQ=DAILY', wed)).toMatchObject({ kind: 'daily', ends: 'never' })
    expect(parseRrule('RRULE:FREQ=DAILY;COUNT=5', wed)).toMatchObject({
      kind: 'daily',
      ends: 'after',
      count: 5,
    })
    expect(parseRrule('freq=weekly;byday=mo,we', wed)).toMatchObject({
      kind: 'weekly',
      weekdays: [1, 3],
    })
    expect(parseRrule('FREQ=WEEKLY', wed)).toMatchObject({ kind: 'weekly', weekdays: [3] })
    expect(parseRrule('FREQ=WEEKLY;BYDAY=MO;WKST=SU;INTERVAL=1', wed).kind).toBe('weekly')
    expect(parseRrule('FREQ=MONTHLY', wed).kind).toBe('monthly')
    expect(parseRrule('FREQ=MONTHLY;BYMONTHDAY=30', wed).kind).toBe('monthly')
    expect(parseRrule('FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=30', wed).kind).toBe('yearly')
    // Google writes "every weekday" as a daily rule
    expect(parseRrule('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', wed)).toMatchObject({
      kind: 'weekly',
      weekdays: [1, 2, 3, 4, 5],
    })
  })

  it('keeps everything else verbatim as custom', () => {
    for (const rule of [
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
      'FREQ=MONTHLY;BYDAY=2TU',
      'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1',
      'FREQ=MONTHLY;BYMONTHDAY=15',
      'FREQ=YEARLY;BYMONTH=3',
      'FREQ=HOURLY',
      'FREQ=DAILY;COUNT=3;UNTIL=20261231',
      'FREQ=DAILY;COUNT=0',
      'FREQ=DAILY;UNTIL=soon',
      'FREQ=DAILY;FREQ=WEEKLY',
      'nonsense',
    ]) {
      const parsed = parseRrule(rule, wed)
      expect(parsed.kind, rule).toBe('custom')
      expect(parsed.raw, rule).toBe(rule)
    }
  })

  it('reads UNTIL as the local day it ends on', () => {
    // 22:59:59 UTC is 23:59:59 in Berlin in winter
    expect(parseRrule('FREQ=DAILY;UNTIL=20261231T225959Z', wed)).toMatchObject({
      ends: 'on',
      until: '2026-12-31',
    })
    // midnight UTC is already 1 January in Berlin
    expect(parseRrule('FREQ=DAILY;UNTIL=20261231T230000Z', wed).until).toBe('2027-01-01')
    expect(parseRrule('FREQ=DAILY;UNTIL=20261231', wed).until).toBe('2026-12-31')
    expect(parseRrule('FREQ=DAILY;UNTIL=20261231T120000', wed).until).toBe('2026-12-31')
  })

  it('builds rules for the presets', () => {
    const rule = (patch: Partial<RepeatRule>): RepeatRule => ({ ...noRepeat(), ...patch })
    expect(buildRrule(rule({}), wed, false)).toBeNull()
    expect(buildRrule(rule({ kind: 'daily' }), wed, false)).toBe('FREQ=DAILY')
    expect(buildRrule(rule({ kind: 'weekly', weekdays: [3, 1] }), wed, false)).toBe(
      'FREQ=WEEKLY;BYDAY=MO,WE',
    )
    expect(buildRrule(rule({ kind: 'weekly', weekdays: [0, 6, 1] }), wed, false)).toBe(
      'FREQ=WEEKLY;BYDAY=MO,SA,SU',
    )
    expect(buildRrule(rule({ kind: 'weekly', weekdays: [] }), wed, false)).toBe(
      'FREQ=WEEKLY;BYDAY=WE',
    )
    expect(buildRrule(rule({ kind: 'monthly', ends: 'after', count: 12 }), wed, false)).toBe(
      'FREQ=MONTHLY;COUNT=12',
    )
    expect(buildRrule(rule({ kind: 'yearly', ends: 'after', count: 0 }), wed, false)).toBe(
      'FREQ=YEARLY;COUNT=1',
    )
    expect(buildRrule(rule({ kind: 'custom', raw: 'FREQ=MONTHLY;BYDAY=2TU' }), wed, false)).toBe(
      'FREQ=MONTHLY;BYDAY=2TU',
    )
  })

  it('ends timed series at the end of the chosen local day, in UTC', () => {
    const winter = {
      ...noRepeat(),
      kind: 'daily' as const,
      ends: 'on' as const,
      until: '2026-12-31',
    }
    expect(buildRrule(winter, wed, false)).toBe('FREQ=DAILY;UNTIL=20261231T225959Z')
    const summer = { ...winter, until: '2026-07-31' }
    expect(buildRrule(summer, d(2026, 7, 1, 9), false)).toBe('FREQ=DAILY;UNTIL=20260731T215959Z')
    // all-day series take a DATE, as DTSTART does
    expect(buildRrule(winter, wed, true)).toBe('FREQ=DAILY;UNTIL=20261231')
  })

  it('round-trips every preset', () => {
    const rules: RepeatRule[] = [
      { ...noRepeat(), kind: 'daily' },
      { ...noRepeat(), kind: 'weekly', weekdays: [1, 3, 5] },
      { ...noRepeat(), kind: 'monthly', ends: 'after', count: 6 },
      { ...noRepeat(), kind: 'yearly', ends: 'on', until: '2030-09-30' },
      { ...noRepeat(), kind: 'weekly', weekdays: [0], ends: 'on', until: '2026-10-25' },
    ]
    for (const rule of rules) {
      for (const allDay of [false, true]) {
        const built = buildRrule(rule, wed, allDay)!
        const back = parseRrule(built, wed)
        expect(back.kind, built).toBe(rule.kind)
        expect(back.ends, built).toBe(rule.ends)
        if (rule.kind === 'weekly') expect(back.weekdays, built).toEqual(rule.weekdays)
        if (rule.ends === 'on') expect(back.until, built).toBe(rule.until)
        if (rule.ends === 'after') expect(back.count, built).toBe(rule.count)
      }
    }
  })

  it('flags a series that ends before it starts', () => {
    const rule = { ...noRepeat(), kind: 'daily' as const, ends: 'on' as const, until: '2026-09-29' }
    expect(repeatProblem(rule, wed)).toBe('until-before-start')
    expect(repeatProblem({ ...rule, until: '2026-09-30' }, wed)).toBeNull()
    expect(repeatProblem({ ...rule, until: '' }, wed)).toBe('until-before-start')
    expect(repeatProblem({ ...rule, kind: 'none' }, wed)).toBeNull()
  })

  it('works on a DST day itself', () => {
    const dstStart = d(2026, 3, 29, 10)
    expect(startOfDay(dstStart).getHours()).toBe(0)
    const rule = {
      ...noRepeat(),
      kind: 'weekly' as const,
      weekdays: [0],
      ends: 'on' as const,
      until: '2026-03-29',
    }
    expect(buildRrule(rule, dstStart, false)).toBe('FREQ=WEEKLY;BYDAY=SU;UNTIL=20260329T215959Z')
  })
})
