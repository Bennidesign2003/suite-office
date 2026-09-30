import { useMemo, type CSSProperties, type ReactElement } from 'react'
import type { CalendarEvent, CalendarInfo } from '../../shared/pim'
import {
  addDays,
  AGENDA_DAYS,
  daysBetween,
  eventSpan,
  formatDay,
  formatTime,
  formatTimeRange,
  isValidDate,
  overlapsDay,
  type EventSpan,
} from './dates'
import { IconRepeat } from './EventDetails'
import type { CalT } from './i18n'

/** The next weeks as a list, grouped by day; days without events are left out. */

interface AgendaViewProps {
  t: CalT
  lang: string
  days: Date[]
  events: CalendarEvent[]
  calendars: ReadonlyMap<string, CalendarInfo>
  now: Date
  selectedId: string | null
  onSelect(event: CalendarEvent, rect: DOMRect): void
  onOpen(event: CalendarEvent): void
}

export function AgendaView(props: AgendaViewProps): ReactElement {
  const { t, lang, days, events, calendars, now, selectedId } = props

  const groups = useMemo(() => {
    const placed = events
      .map((event) => ({ event, span: eventSpan(event) }))
      .filter((p) => isValidDate(p.span.start))
    return days
      .map((day) => {
        const next = addDays(day, 1)
        const items = placed
          .filter((p) => overlapsDay(p.span, day))
          .map((p) => ({
            ...p,
            whole: p.span.allDay || (p.span.start <= day && p.span.end >= next),
          }))
          .sort(
            (a, b) =>
              Number(b.whole) - Number(a.whole) ||
              a.span.start.getTime() - b.span.start.getTime() ||
              a.event.title.localeCompare(b.event.title),
          )
        return { day, items }
      })
      .filter((g) => g.items.length > 0)
  }, [days, events])

  const timeText = (span: EventSpan, whole: boolean, day: Date): string => {
    if (whole) return t('allDay')
    const next = addDays(day, 1)
    if (span.start < day) return t('untilTime', { time: formatTime(span.end, lang) })
    if (span.end > next) return t('fromTime', { time: formatTime(span.start, lang) })
    if (span.start.getTime() === span.end.getTime()) return formatTime(span.start, lang)
    return formatTimeRange(span.start, span.end, lang)
  }

  if (!groups.length) {
    return (
      <div className="cal-agenda">
        <p className="cal-empty">{t('agendaEmpty', { n: String(AGENDA_DAYS) })}</p>
      </div>
    )
  }

  return (
    <div className="cal-agenda">
      {groups.map(({ day, items }) => {
        const offset = daysBetween(now, day)
        const prefix = offset === 0 ? t('today') : offset === 1 ? t('tomorrow') : ''
        return (
          <section key={day.getTime()} className="cal-agenda-day">
            <h3 className={offset === 0 ? 'today' : undefined}>
              {prefix && <span className="cal-agenda-rel">{prefix}</span>}
              {formatDay(day, lang, 'long')}
            </h3>
            <ul>
              {items.map(({ event, span, whole }) => {
                const calendar = calendars.get(event.calendarId)
                return (
                  <li key={event.id}>
                    <button
                      type="button"
                      className={
                        `cal-agenda-item${event.id === selectedId ? ' selected' : ''}` +
                        `${event.status === 'cancelled' ? ' cancelled' : ''}`
                      }
                      style={{ '--ev-color': calendar?.color ?? 'currentColor' } as CSSProperties}
                      onClick={(e) =>
                        props.onSelect(event, e.currentTarget.getBoundingClientRect())
                      }
                      onDoubleClick={() => props.onOpen(event)}
                    >
                      <span className="cal-agenda-time">{timeText(span, whole, day)}</span>
                      <span className="cal-agenda-bar" aria-hidden />
                      <span className="cal-agenda-main">
                        <span className="cal-agenda-title">
                          {event.title.trim() || t('noTitle')}
                          {event.recurring && <IconRepeat />}
                        </span>
                        {(event.location.trim() || calendar) && (
                          <span className="cal-agenda-sub">
                            {[event.location.trim(), calendar?.name].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
