import { join } from 'node:path'
import type { CalendarEvent } from '../../shared/pim'
import { readJson, writeJsonAtomic } from './store'

/**
 * Calendar reminders (VALARM): a desktop notification when an event's alarm
 * comes due. The upcoming events are cached for a few minutes (expanding
 * recurrences every tick would be wasteful); which alarms already fired is
 * kept on disk, so a restart neither repeats nor loses one. An alarm that came
 * due while the app was closed still shows as long as its event has not ended —
 * like Outlook's overdue reminders.
 */

export interface ReminderHost {
  /** events overlapping [from, to), recurrences expanded */
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>
  /** <userData>/pim */
  dir(): string
  notify(title: string, body: string, onClick: () => void): void
  openCalendar(): void
  lang(): string
}

const TICK_MS = 30_000
const REFRESH_MS = 5 * 60_000
/** alarms further ahead than this are picked up by a later refresh */
const LOOKAHEAD_MS = 8 * 24 * 3600_000
/** fired-alarm records are kept this long, then forgotten */
const KEEP_MS = 3 * 24 * 3600_000

type Fired = Record<string, number>

/** an all-day date means local midnight of that day */
export function eventInstant(value: string): number {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (date) return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime()
  return Date.parse(value)
}

export interface DueAlarm {
  key: string
  event: CalendarEvent
  minutes: number
}

/** alarms that are due at `now` and not yet shown */
export function dueAlarms(events: CalendarEvent[], now: number, fired: Fired): DueAlarm[] {
  const due: DueAlarm[] = []
  for (const event of events) {
    if (event.status === 'cancelled' || !event.reminders.length) continue
    const start = eventInstant(event.start)
    const end = eventInstant(event.end)
    if (!Number.isFinite(start) || !(Math.max(end, start) > now)) continue
    for (const minutes of event.reminders) {
      if (!Number.isFinite(minutes)) continue
      const key = `${event.id}|${minutes}`
      if (Object.hasOwn(fired, key)) continue
      if (start - minutes * 60_000 <= now) due.push({ key, event, minutes })
    }
  }
  // one notification per event even when two of its alarms are overdue
  const seen = new Set<string>()
  return due.filter((d) => (seen.has(d.event.id) ? false : (seen.add(d.event.id), true)))
}

export function reminderText(
  event: CalendarEvent,
  now: number,
  lang: string,
): { title: string; body: string } {
  const de = lang.toLowerCase().startsWith('de')
  const locale = de ? 'de-DE' : lang || 'en'
  const start = eventInstant(event.start)
  let when: string
  if (event.allDay) {
    when = new Date(start).toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    })
  } else {
    const time = new Date(start).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    const minutes = Math.round((start - now) / 60_000)
    if (minutes <= 0) when = de ? `Seit ${time}` : `Since ${time}`
    else if (minutes < 60)
      when = de ? `In ${minutes} Min. (${time})` : `In ${minutes} min (${time})`
    else {
      const sameDay = new Date(start).toDateString() === new Date(now).toDateString()
      when = sameDay
        ? de
          ? `Heute um ${time}`
          : `Today at ${time}`
        : new Date(start).toLocaleString(locale, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })
    }
  }
  const title = event.title.trim() || (de ? 'Termin' : 'Event')
  return { title, body: event.location ? `${when} · ${event.location}` : when }
}

export class Reminders {
  private events: CalendarEvent[] = []
  private loadedAt = 0
  private loading: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly host: ReminderHost) {}

  private file(): string {
    return join(this.host.dir(), 'reminders-fired.json')
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** calendars changed: reload the upcoming events on the next tick */
  invalidate(): void {
    this.loadedAt = 0
  }

  private async refresh(now: number): Promise<void> {
    this.loading ??= (async () => {
      try {
        // events that started up to a day ago may still be running
        this.events = await this.host.listEvents(
          new Date(now - 24 * 3600_000),
          new Date(now + LOOKAHEAD_MS),
        )
        this.loadedAt = now
      } catch {
        // keep the previous list; the next tick tries again
      }
    })().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  async tick(now = Date.now()): Promise<void> {
    if (now - this.loadedAt > REFRESH_MS) await this.refresh(now)
    const fired = readJson<Fired>(this.file(), {})
    const due = dueAlarms(this.events, now, fired)
    if (!due.length) return
    for (const alarm of due) {
      const text = reminderText(alarm.event, now, this.host.lang())
      try {
        this.host.notify(text.title, text.body, () => this.host.openCalendar())
      } catch {
        // no notification service (e.g. a headless session)
      }
    }
    // a shown event's other overdue alarms count as shown too; later ones stay armed
    const next: Fired = {}
    for (const [key, at] of Object.entries(fired)) if (now - at < KEEP_MS) next[key] = at
    for (const alarm of due) {
      const start = eventInstant(alarm.event.start)
      for (const minutes of alarm.event.reminders) {
        if (start - minutes * 60_000 <= now) next[`${alarm.event.id}|${minutes}`] = now
      }
    }
    try {
      writeJsonAtomic(this.file(), next)
    } catch {
      // read-only profile: at worst an alarm shows again after a restart
    }
  }
}
