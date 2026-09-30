import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'
import type { CalendarEvent } from '../../shared/pim'
import {
  addDays,
  dayCells,
  eventSpan,
  formatDay,
  formatTime,
  isLongEvent,
  isValidDate,
  sameDay,
  weekdayNames,
  weekOrder,
} from './dates'
import type { CalT } from './i18n'
import { fitRows, packRows } from './layout'

/**
 * The month grid: one row per week, events as chips (timed) or bars (all-day
 * and multi-day). A day holds as many chips as fit; the rest collapse into
 * "+N more", which opens that day.
 */

const DAY_HEAD_PX = 26
const CHIP_PX = 22

interface MonthViewProps {
  t: CalT
  lang: string
  weekStart: number
  days: Date[]
  /** any day of the month shown; days outside it are dimmed */
  month: Date
  events: CalendarEvent[]
  colors: ReadonlyMap<string, string>
  now: Date
  selectedId: string | null
  onSelect(event: CalendarEvent, rect: DOMRect): void
  onOpen(event: CalendarEvent): void
  onOpenDay(day: Date): void
  onCreate(start: Date, end: Date, allDay: boolean): void
}

export function MonthView(props: MonthViewProps): ReactElement {
  const { t, lang, weekStart, days, month, events, colors, now, selectedId } = props
  const bodyRef = useRef<HTMLDivElement>(null)
  const [capacity, setCapacity] = useState(3)

  const weeks = useMemo(() => {
    const out: Date[][] = []
    for (let i = 0; i < days.length; i += 7) out.push(days.slice(i, i + 7))
    return out
  }, [days])

  // how many chips fit under a day number depends on the window height
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = (): void => {
      const row = el.firstElementChild as HTMLElement | null
      if (!row) return
      const fit = Math.floor((row.clientHeight - DAY_HEAD_PX - 2) / CHIP_PX)
      setCapacity(Math.max(1, fit))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [weeks.length])

  const placed = useMemo(
    () =>
      events
        .map((event) => ({ event, span: eventSpan(event) }))
        .filter((p) => isValidDate(p.span.start)),
    [events],
  )

  const layouts = useMemo(
    () =>
      weeks.map((week) => {
        const bars = placed
          .map((p) => ({ ...p, cells: dayCells(p.span, week[0]!, 7) }))
          .filter((b): b is typeof b & { cells: NonNullable<typeof b.cells> } => b.cells !== null)
        const items = bars.map((b) => ({
          id: b.event.id,
          start: b.cells.start,
          end: b.cells.end,
          rank: b.span.allDay ? -1 : b.span.start.getTime(),
        }))
        const rows = packRows(items)
        return { bars, rows, fit: fitRows(items, rows, 7, capacity) }
      }),
    [weeks, placed, capacity],
  )

  const headNames = weekdayNames(lang, 'long')
  const title = (ev: CalendarEvent): string => ev.title.trim() || t('noTitle')

  return (
    <div className="cal-month">
      <div className="cal-month-head" aria-hidden>
        {weekOrder(weekStart).map((d) => (
          <div key={d} className="cal-month-dow">
            {headNames[d]}
          </div>
        ))}
      </div>
      <div
        className="cal-month-body"
        ref={bodyRef}
        style={{ '--cal-weeks': weeks.length } as CSSProperties}
      >
        {weeks.map((week, w) => {
          const { bars, rows, fit } = layouts[w]!
          return (
            <div key={week[0]!.getTime()} className="cal-week">
              <div className="cal-week-cells">
                {week.map((day) => {
                  const outside = day.getMonth() !== month.getMonth()
                  const today = sameDay(day, now)
                  const weekend = day.getDay() === 0 || day.getDay() === 6
                  return (
                    <div
                      key={day.getTime()}
                      className={`cal-cell${outside ? ' outside' : ''}${weekend ? ' weekend' : ''}${today ? ' today' : ''}`}
                      onDoubleClick={() => props.onCreate(day, addDays(day, 1), true)}
                    >
                      <button
                        type="button"
                        className="cal-cell-num"
                        title={t('openDay', { date: formatDay(day, lang, 'long') })}
                        aria-current={today ? 'date' : undefined}
                        onClick={() => props.onOpenDay(day)}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        {day.getDate() === 1 ? formatDay(day, lang, 'short') : day.getDate()}
                      </button>
                    </div>
                  )
                })}
              </div>
              <div className="cal-week-events" style={{ top: DAY_HEAD_PX }}>
                {bars
                  .filter((b) => fit.visible.has(b.event.id))
                  .map((b) => {
                    const row = rows.get(b.event.id) ?? 0
                    const bar =
                      b.span.allDay || isLongEvent(b.span) || b.cells.end - b.cells.start > 1
                    const style = {
                      '--ev-color': colors.get(b.event.calendarId) ?? 'currentColor',
                      top: row * CHIP_PX,
                      left: `calc(${(b.cells.start / 7) * 100}% + 2px)`,
                      width: `calc(${((b.cells.end - b.cells.start) / 7) * 100}% - 4px)`,
                    } as CSSProperties
                    const time =
                      b.span.allDay || b.cells.clippedStart ? '' : formatTime(b.span.start, lang)
                    return (
                      <button
                        key={b.event.id}
                        type="button"
                        className={
                          `cal-event ${bar ? 'cal-bar' : 'cal-chip'}` +
                          `${b.cells.clippedStart ? ' clip-start' : ''}${b.cells.clippedEnd ? ' clip-end' : ''}` +
                          `${b.event.id === selectedId ? ' selected' : ''}` +
                          `${b.event.status === 'cancelled' ? ' cancelled' : ''}` +
                          `${b.event.status === 'tentative' ? ' tentative' : ''}`
                        }
                        style={style}
                        title={`${time ? `${time} ` : ''}${title(b.event)}${b.event.location ? `\n${b.event.location}` : ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          props.onSelect(b.event, e.currentTarget.getBoundingClientRect())
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          props.onOpen(b.event)
                        }}
                      >
                        {!bar && <span className="cal-dot" aria-hidden />}
                        {time && <span className="cal-chip-time">{time}</span>}
                        <span className="cal-event-title">{title(b.event)}</span>
                      </button>
                    )
                  })}
                {fit.hidden.map((count, i) =>
                  count > 0 ? (
                    <button
                      key={`more-${i}`}
                      type="button"
                      className="cal-more"
                      style={{
                        top: (capacity - 1) * CHIP_PX,
                        left: `calc(${(i / 7) * 100}% + 2px)`,
                        width: `calc(${100 / 7}% - 4px)`,
                      }}
                      onClick={() => props.onOpenDay(week[i]!)}
                    >
                      {t('moreEvents', { n: String(count) })}
                    </button>
                  ) : null,
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
