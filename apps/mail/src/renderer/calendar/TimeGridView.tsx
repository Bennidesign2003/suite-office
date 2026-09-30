import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import type { CalendarEvent } from '../../shared/pim'
import {
  addDays,
  dayCells,
  eventSpan,
  formatDay,
  formatHour,
  formatTime,
  formatTimeRange,
  isLongEvent,
  isValidDate,
  minutesOfDay,
  overlapsDay,
  sameDay,
  weekdayNames,
  type EventSpan,
} from './dates'
import { IconRepeat } from './EventDetails'
import type { CalT } from './i18n'
import { layoutColumns, packRows } from './layout'

/**
 * Day, work week and week: an all-day lane on top and 24 scrollable hours of
 * 30-minute slots below. Click a slot for a one-hour event, drag across slots
 * for a longer one; overlapping events share the column side by side.
 */

const HOUR_PX = 48
const SLOT_MINUTES = 30
const SLOT_PX = (HOUR_PX * SLOT_MINUTES) / 60
const SLOTS = (24 * 60) / SLOT_MINUTES
const PX_PER_MIN = HOUR_PX / 60
const MIN_EVENT_PX = 20
const LANE_ROW_PX = 24
const SCROLL_TO_HOUR = 7
const WORK_START = 8
const WORK_END = 18

interface TimeGridProps {
  t: CalT
  lang: string
  days: Date[]
  events: CalendarEvent[]
  colors: ReadonlyMap<string, string>
  now: Date
  selectedId: string | null
  onSelect(event: CalendarEvent, rect: DOMRect): void
  onOpen(event: CalendarEvent): void
  onCreate(start: Date, end: Date, allDay: boolean): void
  onOpenDay(day: Date): void
}

interface Placed {
  event: CalendarEvent
  span: EventSpan
}

interface Segment extends Placed {
  startMin: number
  endMin: number
}

interface Drag {
  day: number
  from: number
  to: number
}

const at = (day: Date, minutes: number): Date =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes)

function colorStyle(color: string | undefined): CSSProperties {
  return { '--ev-color': color ?? 'currentColor' } as CSSProperties
}

export function TimeGridView(props: TimeGridProps): ReactElement {
  const { t, lang, days, events, now, selectedId } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dayNames = useMemo(() => weekdayNames(lang, 'short'), [lang])
  const n = days.length
  const first = days[0]!

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = SCROLL_TO_HOUR * HOUR_PX - 8
  }, [])

  const placed = useMemo(
    () =>
      events
        .map((event) => ({ event, span: eventSpan(event) }))
        .filter((p) => isValidDate(p.span.start)),
    [events],
  )

  // the all-day lane: all-day events and anything a day or longer
  const lane = useMemo(() => {
    const bars = placed
      .filter((p) => isLongEvent(p.span))
      .map((p) => ({ ...p, cells: dayCells(p.span, first, n) }))
      .filter((b): b is Placed & { cells: NonNullable<typeof b.cells> } => b.cells !== null)
    const rows = packRows(
      bars.map((b) => ({
        id: b.event.id,
        start: b.cells.start,
        end: b.cells.end,
        rank: b.span.allDay ? -1 : b.span.start.getTime(),
      })),
    )
    const count = bars.reduce((max, b) => Math.max(max, (rows.get(b.event.id) ?? 0) + 1), 0)
    return { bars, rows, count }
  }, [placed, first, n])

  // per day: the timed pieces of shorter events, laid out in columns
  const columns = useMemo(
    () =>
      days.map((day) => {
        const next = addDays(day, 1)
        const segments: Segment[] = placed
          .filter((p) => !isLongEvent(p.span) && overlapsDay(p.span, day))
          .map((p) => {
            const startMin = p.span.start <= day ? 0 : minutesOfDay(p.span.start)
            const endMin = p.span.end >= next ? 24 * 60 : minutesOfDay(p.span.end)
            // a fall-back DST hour can make the wall-clock end look earlier
            return { ...p, startMin, endMin: Math.max(startMin, endMin) }
          })
        const layout = layoutColumns(
          segments.map((s) => ({ id: s.event.id, start: s.startMin, end: s.endMin })),
          MIN_EVENT_PX / PX_PER_MIN,
        )
        return { segments, layout }
      }),
    [days, placed],
  )

  const slotAt = (e: ReactPointerEvent<HTMLElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    return Math.min(SLOTS - 1, Math.max(0, Math.floor((e.clientY - rect.top) / SLOT_PX)))
  }

  const finishDrag = (): void => {
    if (!drag) return
    setDrag(null)
    const day = days[drag.day]
    if (!day) return
    const lo = Math.min(drag.from, drag.to)
    const hi = Math.max(drag.from, drag.to)
    const start = at(day, lo * SLOT_MINUTES)
    const end = lo === hi ? at(day, lo * SLOT_MINUTES + 60) : at(day, (hi + 1) * SLOT_MINUTES)
    props.onCreate(start, end, false)
  }

  const eventTitle = (ev: CalendarEvent): string => ev.title.trim() || t('noTitle')

  const selectHandlers = (ev: CalendarEvent) => ({
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      e.stopPropagation()
      props.onSelect(ev, e.currentTarget.getBoundingClientRect())
    },
    onDoubleClick: (e: ReactMouseEvent<HTMLElement>) => {
      e.stopPropagation()
      props.onOpen(ev)
    },
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => e.stopPropagation(),
  })

  const eventClass = (ev: CalendarEvent, extra: string): string =>
    `cal-event ${extra}${ev.id === selectedId ? ' selected' : ''}` +
    `${ev.status === 'cancelled' ? ' cancelled' : ''}${ev.status === 'tentative' ? ' tentative' : ''}`

  const gridStyle = { '--cal-days': n, '--cal-hour': `${HOUR_PX}px` } as CSSProperties

  return (
    <div className="cal-grid" style={gridStyle}>
      <div className="cal-grid-head">
        <div className="cal-gutter" />
        <div className="cal-day-heads">
          {days.map((day) => {
            const today = sameDay(day, now)
            return (
              <button
                key={day.getTime()}
                type="button"
                className={`cal-day-head${today ? ' today' : ''}`}
                title={t('openDay', { date: formatDay(day, lang, 'long') })}
                aria-current={today ? 'date' : undefined}
                onClick={() => props.onOpenDay(day)}
              >
                <span className="cal-day-num">{day.getDate()}</span>
                <span className="cal-day-name">{dayNames[day.getDay()]}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="cal-allday-row">
        <div className="cal-gutter cal-allday-label">{t('allDay')}</div>
        <div
          className="cal-allday-lane"
          style={{ height: Math.max(1, lane.count) * LANE_ROW_PX + 6 }}
        >
          <div className="cal-allday-cells" aria-hidden>
            {days.map((day) => (
              <div
                key={day.getTime()}
                className="cal-allday-cell"
                onClick={() => props.onCreate(day, addDays(day, 1), true)}
              />
            ))}
          </div>
          {lane.bars.map((b) => {
            const row = lane.rows.get(b.event.id) ?? 0
            const style: CSSProperties = {
              ...colorStyle(props.colors.get(b.event.calendarId)),
              top: row * LANE_ROW_PX + 3,
              left: `calc(${(b.cells.start / n) * 100}% + 2px)`,
              width: `calc(${((b.cells.end - b.cells.start) / n) * 100}% - 4px)`,
            }
            const time = b.span.allDay ? '' : `${formatTime(b.span.start, lang)} `
            return (
              <button
                key={b.event.id}
                type="button"
                className={eventClass(
                  b.event,
                  `cal-bar${b.cells.clippedStart ? ' clip-start' : ''}${b.cells.clippedEnd ? ' clip-end' : ''}`,
                )}
                style={style}
                title={`${eventTitle(b.event)}${b.event.location ? `\n${b.event.location}` : ''}`}
                {...selectHandlers(b.event)}
              >
                {b.event.recurring && <IconRepeat />}
                <span className="cal-event-title">
                  {!b.cells.clippedStart && time}
                  {eventTitle(b.event)}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="cal-grid-body" ref={scrollRef}>
        <div className="cal-grid-inner">
          <div className="cal-hours" aria-hidden>
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <span key={h} className="cal-hour-label" style={{ top: h * HOUR_PX }}>
                {formatHour(h, lang)}
              </span>
            ))}
          </div>
          <div className="cal-columns">
            {days.map((day, i) => {
              const today = sameDay(day, now)
              const weekend = day.getDay() === 0 || day.getDay() === 6
              const { segments, layout } = columns[i]!
              const selection =
                drag && drag.day === i
                  ? { lo: Math.min(drag.from, drag.to), hi: Math.max(drag.from, drag.to) }
                  : null
              return (
                <div
                  key={day.getTime()}
                  className={`cal-column${weekend ? ' weekend' : ''}${today ? ' today' : ''}`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    const slot = slotAt(e)
                    e.currentTarget.setPointerCapture(e.pointerId)
                    setDrag({ day: i, from: slot, to: slot })
                  }}
                  onPointerMove={(e) => {
                    if (!drag || drag.day !== i) return
                    const slot = slotAt(e)
                    if (slot !== drag.to) setDrag({ ...drag, to: slot })
                  }}
                  onPointerUp={finishDrag}
                  onPointerCancel={() => setDrag(null)}
                >
                  {!weekend && (
                    <div
                      className="cal-workhours"
                      style={{
                        top: WORK_START * HOUR_PX,
                        height: (WORK_END - WORK_START) * HOUR_PX,
                      }}
                    />
                  )}
                  {selection && (
                    <div
                      className="cal-drag"
                      style={{
                        top: selection.lo * SLOT_PX,
                        height:
                          (selection.lo === selection.hi ? 2 : selection.hi - selection.lo + 1) *
                          SLOT_PX,
                      }}
                    >
                      {formatTimeRange(
                        at(day, selection.lo * SLOT_MINUTES),
                        at(
                          day,
                          selection.lo === selection.hi
                            ? selection.lo * SLOT_MINUTES + 60
                            : (selection.hi + 1) * SLOT_MINUTES,
                        ),
                        lang,
                      )}
                    </div>
                  )}
                  {segments.map((s) => {
                    const place = layout.get(s.event.id) ?? { column: 0, columns: 1, span: 1 }
                    const height = Math.max(MIN_EVENT_PX, (s.endMin - s.startMin) * PX_PER_MIN) - 1
                    const short = height < 34
                    const roomy = height >= 52
                    const time = formatTimeRange(s.span.start, s.span.end, lang)
                    const style: CSSProperties = {
                      ...colorStyle(props.colors.get(s.event.calendarId)),
                      top: s.startMin * PX_PER_MIN,
                      height,
                      left: `calc(${(place.column / place.columns) * 100}% + 1px)`,
                      width: `calc(${(place.span / place.columns) * 100}% - 3px)`,
                    }
                    return (
                      <button
                        key={s.event.id}
                        type="button"
                        className={eventClass(s.event, short ? 'cal-block short' : 'cal-block')}
                        style={style}
                        title={`${eventTitle(s.event)}\n${time}${s.event.location ? `\n${s.event.location}` : ''}`}
                        {...selectHandlers(s.event)}
                      >
                        <span className="cal-event-title">
                          {s.event.recurring && <IconRepeat />}
                          {eventTitle(s.event)}
                          {short && <span className="cal-event-time">, {time}</span>}
                        </span>
                        {!short && <span className="cal-event-time">{time}</span>}
                        {roomy && s.event.location.trim() && (
                          <span className="cal-event-loc">{s.event.location}</span>
                        )}
                      </button>
                    )
                  })}
                  {today && (
                    <div
                      className="cal-now"
                      style={{ top: minutesOfDay(now) * PX_PER_MIN }}
                      aria-hidden
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
