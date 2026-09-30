import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../src/shared/pim'
import { dueAlarms, reminderText, Reminders } from '../src/main/pim/reminders'

const NOW = Date.parse('2026-10-01T12:00:00Z')

function event(patch: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'local:default|a@x|2026-10-01T12:30:00Z',
    uid: 'a@x',
    calendarId: 'local:default',
    title: 'Zahnarzt',
    location: '',
    description: '',
    start: '2026-10-01T12:30:00Z',
    end: '2026-10-01T13:30:00Z',
    allDay: false,
    recurring: false,
    status: 'confirmed',
    attendees: [],
    reminders: [15],
    readOnly: false,
    ...patch,
  }
}

describe('dueAlarms', () => {
  it('fires once the alarm time is reached, not before', () => {
    const e = event({ reminders: [15] })
    expect(dueAlarms([e], NOW, {})).toEqual([])
    expect(dueAlarms([e], NOW + 15 * 60_000, {})).toHaveLength(1)
  })

  it('skips fired, cancelled and finished events', () => {
    const e = event({ reminders: [60] })
    expect(dueAlarms([e], NOW, {})).toHaveLength(1)
    expect(dueAlarms([e], NOW, { [`${e.id}|60`]: NOW })).toEqual([])
    expect(dueAlarms([{ ...e, status: 'cancelled' }], NOW, {})).toEqual([])
    expect(dueAlarms([e], Date.parse('2026-10-01T14:00:00Z'), {})).toEqual([])
  })

  it('still shows an overdue alarm while the event runs, once per event', () => {
    const e = event({ reminders: [1440, 60, 15] })
    const due = dueAlarms([e], Date.parse('2026-10-01T12:45:00Z'), {})
    expect(due).toHaveLength(1)
  })

  it('treats all-day dates as local midnight', () => {
    const e = event({ allDay: true, start: '2026-10-02', end: '2026-10-03', reminders: [0] })
    const midnight = new Date(2026, 9, 2).getTime()
    expect(dueAlarms([e], midnight - 1000, {})).toEqual([])
    expect(dueAlarms([e], midnight, {})).toHaveLength(1)
  })

  it('ignores a garbled start', () => {
    expect(dueAlarms([event({ start: 'nonsense' })], NOW, {})).toEqual([])
  })
})

describe('reminderText', () => {
  it('says how long until the event and where', () => {
    const t = reminderText(event({ location: 'Hauptstraße 5' }), NOW + 20 * 60_000, 'de')
    expect(t.title).toBe('Zahnarzt')
    expect(t.body).toMatch(/^In 10 Min\. \(.+\) · Hauptstraße 5$/)
    expect(reminderText(event({}), NOW + 45 * 60_000, 'en').body).toMatch(/^Since /)
  })
})

describe('Reminders', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('notifies once per alarm and remembers it across restarts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'reminders-'))
    const shown: string[] = []
    const e = event({ reminders: [1440, 15] })
    const host = {
      listEvents: async () => [e],
      dir: () => dir,
      notify: (title: string) => void shown.push(title),
      openCalendar: () => undefined,
      lang: () => 'de',
    }
    const first = new Reminders(host)
    // one day ahead: the 1-day alarm fires, the 15-minute one stays armed
    await first.tick(Date.parse('2026-09-30T12:31:00Z'))
    await first.tick(Date.parse('2026-09-30T12:32:00Z'))
    expect(shown).toEqual(['Zahnarzt'])
    const second = new Reminders(host)
    await second.tick(Date.parse('2026-10-01T12:00:00Z'))
    expect(shown).toEqual(['Zahnarzt'])
    await second.tick(Date.parse('2026-10-01T12:16:00Z'))
    expect(shown).toEqual(['Zahnarzt', 'Zahnarzt'])
  })

  it('survives a failing calendar and a failing notifier', async () => {
    dir = mkdtempSync(join(tmpdir(), 'reminders-'))
    const reminders = new Reminders({
      listEvents: async () => {
        throw new Error('offline')
      },
      dir: () => dir,
      notify: () => {
        throw new Error('no notifications')
      },
      openCalendar: () => undefined,
      lang: () => 'en',
    })
    await expect(reminders.tick(NOW)).resolves.toBeUndefined()
  })
})
