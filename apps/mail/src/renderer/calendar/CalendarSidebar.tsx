import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import type { CalendarInfo, PimSource } from '../../shared/pim'
import { IconPlus } from '../components/icons'
import {
  addMonths,
  dayKey,
  formatDay,
  formatMonth,
  formatTime,
  monthGrid,
  sameDay,
  weekdayNames,
  weekOrder,
  type ViewRange,
} from './dates'
import { IconArrowLeft, IconArrowRight, IconMore, IconWarning } from './EventDetails'
import type { CalendarStringKey, CalT } from './i18n'

/**
 * The calendar's left column: a mini month to jump around, and the
 * calendars grouped by where they come from, with visibility, color,
 * rename, import/export and the connection's sync state.
 */

/** Outlook's calendar colors; they are data (stored on the calendar), not theme */
export const CALENDAR_PALETTE: Array<{ color: string; name: CalendarStringKey }> = [
  { color: '#0f6cbd', name: 'colorBlue' },
  { color: '#13a10e', name: 'colorGreen' },
  { color: '#ca5010', name: 'colorOrange' },
  { color: '#8764b8', name: 'colorPurple' },
  { color: '#e3008c', name: 'colorPink' },
  { color: '#8e562e', name: 'colorBrown' },
  { color: '#038387', name: 'colorTeal' },
  { color: '#9a8cdb', name: 'colorLavender' },
  { color: '#d13438', name: 'colorRed' },
  { color: '#4f6bed', name: 'colorIndigo' },
  { color: '#498205', name: 'colorOlive' },
  { color: '#69797e', name: 'colorGray' },
]

/** the first palette color no calendar uses yet */
export function freshColor(calendars: CalendarInfo[]): string {
  const used = new Set(calendars.map((c) => c.color.toLowerCase()))
  return (CALENDAR_PALETTE.find((p) => !used.has(p.color)) ?? CALENDAR_PALETTE[0]!).color
}

const KIND_LABEL: Record<string, CalendarStringKey> = {
  local: 'kindLocal',
  caldav: 'kindCaldav',
  ics: 'kindIcs',
}

interface CalendarSidebarProps {
  t: CalT
  lang: string
  weekStart: number
  now: Date
  miniMonth: Date
  onMiniMonth(month: Date): void
  /** the days the main view shows, highlighted in the mini month */
  range: ViewRange
  /** "YYYY-MM-DD" of days in the mini month that have events */
  markedDays: ReadonlySet<string>
  calendars: CalendarInfo[]
  sources: PimSource[]
  syncingSourceId: string | null
  onPickDay(day: Date): void
  onUpdateCalendar(id: string, patch: { color?: string; visible?: boolean; name?: string }): void
  onShowOnly(calendar: CalendarInfo): void
  onImport(calendar: CalendarInfo): void
  onExport(calendar: CalendarInfo): void
  onCreateCalendar(sourceId: string, name: string, color: string): Promise<boolean>
  onAddSource(): void
  onEditSource(source: PimSource): void
  onRemoveSource(source: PimSource): void
  onSyncSource(source: PimSource): void
}

type Menu = { kind: 'calendar' | 'source'; id: string } | null

export function CalendarSidebar(props: CalendarSidebarProps): ReactElement {
  const { t, lang, weekStart, now, miniMonth, range, markedDays, calendars, sources } = props
  const [menu, setMenu] = useState<Menu>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [creating, setCreating] = useState<{ sourceId: string; value: string } | null>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  // an inline field is finished once: Enter or Esc unmounts it, and the blur
  // that may follow must not save again (or save what Esc threw away)
  const inlineDone = useRef(false)
  const startRename = (cal: CalendarInfo): void => {
    inlineDone.current = false
    setRenaming({ id: cal.id, value: cal.name })
  }
  const startCreate = (sourceId: string): void => {
    inlineDone.current = false
    setCreating({ sourceId, value: '' })
  }
  const finishRename = (save: boolean): void => {
    if (inlineDone.current || !renaming) return
    inlineDone.current = true
    const cal = calendars.find((c) => c.id === renaming.id)
    const name = renaming.value.trim()
    if (save && cal && name && name !== cal.name) props.onUpdateCalendar(cal.id, { name })
    setRenaming(null)
  }

  // menus close on a click elsewhere
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target as HTMLElement
      if (menuRef.current?.contains(target) || target.closest?.('[data-menu-button]')) return
      setMenu(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [menu])

  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLElement>('button, input')?.focus()
  }, [menu])

  // calendar sources only; address books live in the contacts module
  const groups = useMemo(() => {
    const own = sources
      .filter((s) => s.kind !== 'carddav')
      .sort((a, b) => Number(b.kind === 'local') - Number(a.kind === 'local'))
    const known = new Set(own.map((s) => s.id))
    const list = own.map((source) => ({
      source: source as PimSource | null,
      calendars: calendars.filter((c) => c.sourceId === source.id),
    }))
    const orphans = calendars.filter((c) => !known.has(c.sourceId))
    if (orphans.length) list.push({ source: null, calendars: orphans })
    return list
  }, [sources, calendars])

  // ---- mini month ----

  const grid = monthGrid(miniMonth, weekStart)
  const narrow = weekdayNames(lang, 'short').map((n) => n.replace(/\.$/, '').slice(0, 2))
  const inRange = (d: Date): boolean => d >= range.start && d < range.end

  const menuKeys = (e: ReactKeyboardEvent<HTMLUListElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      setMenu(null)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('button') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
    next?.focus()
  }

  const calendarMenu = (cal: CalendarInfo): ReactElement => (
    <ul className="dropdown cal-menu" role="menu" ref={menuRef} onKeyDown={menuKeys}>
      <li className="cal-menu-label">{t('color')}</li>
      <li className="cal-palette" role="none">
        {CALENDAR_PALETTE.map((p) => (
          <button
            key={p.color}
            type="button"
            role="menuitemradio"
            aria-checked={cal.color.toLowerCase() === p.color}
            className={cal.color.toLowerCase() === p.color ? 'on' : undefined}
            style={{ '--swatch': p.color } as CSSProperties}
            title={t(p.name)}
            aria-label={t(p.name)}
            onClick={() => {
              setMenu(null)
              props.onUpdateCalendar(cal.id, { color: p.color })
            }}
          />
        ))}
      </li>
      <li role="none">
        <label className="cal-custom-color">
          <input
            type="color"
            defaultValue={/^#[0-9a-f]{6}$/i.test(cal.color) ? cal.color : '#0f6cbd'}
            // the native "change" fires once the picker closes; React's onChange
            // would save (and sync) on every step of dragging through the colors
            ref={(el) => {
              if (el) el.onchange = () => props.onUpdateCalendar(cal.id, { color: el.value })
            }}
          />
          <span>{t('customColor')}</span>
        </label>
      </li>
      <li className="cal-menu-sep" role="separator" />
      <li role="none">
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setMenu(null)
            startRename(cal)
          }}
        >
          {t('rename')}
        </button>
      </li>
      <li role="none">
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setMenu(null)
            props.onShowOnly(cal)
          }}
        >
          {t('showOnly')}
        </button>
      </li>
      {!cal.readOnly && (
        <li role="none">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null)
              props.onImport(cal)
            }}
          >
            {t('importIcs')}
          </button>
        </li>
      )}
      <li role="none">
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setMenu(null)
            props.onExport(cal)
          }}
        >
          {t('exportIcs')}
        </button>
      </li>
    </ul>
  )

  const sourceMenu = (source: PimSource): ReactElement => (
    <ul className="dropdown cal-menu" role="menu" ref={menuRef} onKeyDown={menuKeys}>
      {source.kind !== 'ics' && (
        <li role="none">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null)
              startCreate(source.id)
            }}
          >
            {t('newCalendar')}
          </button>
        </li>
      )}
      {source.kind !== 'local' && (
        <>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null)
                props.onSyncSource(source)
              }}
            >
              {t('syncNow')}
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null)
                props.onEditSource(source)
              }}
            >
              {t('editSource')}
            </button>
          </li>
          <li className="cal-menu-sep" role="separator" />
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="cal-menu-danger"
              onClick={() => {
                setMenu(null)
                props.onRemoveSource(source)
              }}
            >
              {t('removeSource')}
            </button>
          </li>
        </>
      )}
    </ul>
  )

  const syncLine = (source: PimSource): ReactElement | null => {
    if (source.kind === 'local') return null
    if (props.syncingSourceId === source.id)
      return <span className="cal-source-state">{t('syncNow')} …</span>
    if (source.error)
      return (
        <span className="cal-source-state cal-source-error" title={source.error}>
          <IconWarning /> {source.error}
        </span>
      )
    if (!source.lastSync) return <span className="cal-source-state">{t('neverSynced')}</span>
    const at = new Date(source.lastSync)
    const time = sameDay(at, now)
      ? formatTime(at, lang)
      : `${formatDay(at, lang, 'short')}, ${formatTime(at, lang)}`
    return (
      <span className="cal-source-state" title={at.toLocaleString(lang)}>
        {t('lastSync', { time })}
      </span>
    )
  }

  const finishCreate = async (save: boolean): Promise<void> => {
    if (inlineDone.current || !creating) return
    inlineDone.current = true
    const name = creating.value.trim()
    if (!save || !name) {
      setCreating(null)
      return
    }
    const ok = await props.onCreateCalendar(creating.sourceId, name, freshColor(calendars))
    if (ok) setCreating(null)
    // keep the field for another try
    else inlineDone.current = false
  }

  const localSource = sources.find((s) => s.kind === 'local')

  return (
    <div className="cal-sidebar-inner">
      <section className="cal-mini" aria-label={t('miniCalendar')}>
        <div className="cal-mini-head">
          <span className="cal-mini-title">{formatMonth(miniMonth, lang)}</span>
          <button
            type="button"
            className="icon-btn"
            title={t('prevMonth')}
            aria-label={t('prevMonth')}
            onClick={() => props.onMiniMonth(addMonths(miniMonth, -1))}
          >
            <IconArrowLeft />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t('nextMonth')}
            aria-label={t('nextMonth')}
            onClick={() => props.onMiniMonth(addMonths(miniMonth, 1))}
          >
            <IconArrowRight />
          </button>
        </div>
        <div className="cal-mini-grid" role="grid">
          {weekOrder(weekStart).map((d) => (
            <span key={`h${d}`} className="cal-mini-dow" aria-hidden>
              {narrow[d]}
            </span>
          ))}
          {grid.map((day) => {
            const outside = day.getMonth() !== miniMonth.getMonth()
            const today = sameDay(day, now)
            const classes = [
              'cal-mini-day',
              outside && 'outside',
              today && 'today',
              inRange(day) && 'in-range',
              markedDays.has(dayKey(day)) && 'marked',
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <button
                key={day.getTime()}
                type="button"
                className={classes}
                aria-label={formatDay(day, lang, 'long')}
                aria-current={today ? 'date' : undefined}
                onClick={() => props.onPickDay(day)}
              >
                {day.getDate()}
              </button>
            )
          })}
        </div>
      </section>

      <section className="cal-list" aria-label={t('calendars')}>
        {groups.map(({ source, calendars: list }) => (
          <div key={source?.id ?? 'other'} className="cal-group">
            <div className="cal-group-head">
              <div className="cal-group-title">
                <span className="cal-group-name" title={source?.url ?? source?.name}>
                  {source
                    ? source.kind === 'local'
                      ? t('kindLocal')
                      : source.name
                    : t('otherCalendars')}
                </span>
                {source && source.kind !== 'local' && (
                  <span className="cal-kind">{t(KIND_LABEL[source.kind] ?? 'kindCaldav')}</span>
                )}
              </div>
              {source && (
                <div className="menu-anchor">
                  <button
                    type="button"
                    className="icon-btn"
                    data-menu-button
                    title={t('sourceOptions', { name: source.name })}
                    aria-label={t('sourceOptions', { name: source.name })}
                    aria-haspopup="menu"
                    aria-expanded={menu?.kind === 'source' && menu.id === source.id}
                    onClick={() =>
                      setMenu(
                        menu?.kind === 'source' && menu.id === source.id
                          ? null
                          : { kind: 'source', id: source.id },
                      )
                    }
                  >
                    <IconMore />
                  </button>
                  {menu?.kind === 'source' && menu.id === source.id && sourceMenu(source)}
                </div>
              )}
            </div>
            {source && syncLine(source)}
            <ul className="cal-cals">
              {list.map((cal) => (
                <li
                  key={cal.id}
                  className="cal-cal"
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ kind: 'calendar', id: cal.id })
                  }}
                >
                  {renaming?.id === cal.id ? (
                    <input
                      className="cal-inline-input"
                      value={renaming.value}
                      autoFocus
                      aria-label={t('rename')}
                      onChange={(e) => setRenaming({ id: cal.id, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') finishRename(true)
                        else if (e.key === 'Escape') {
                          e.stopPropagation()
                          finishRename(false)
                        }
                      }}
                      onBlur={() => finishRename(true)}
                    />
                  ) : (
                    <label
                      className="cal-toggle"
                      style={{ '--swatch': cal.color } as CSSProperties}
                      title={cal.name}
                    >
                      <input
                        type="checkbox"
                        checked={cal.visible}
                        aria-label={t('showCalendar', { name: cal.name })}
                        onChange={() => props.onUpdateCalendar(cal.id, { visible: !cal.visible })}
                      />
                      <span className="cal-swatch" aria-hidden />
                      <span className="cal-cal-name">{cal.name}</span>
                      {cal.readOnly && (
                        <span className="cal-ro" title={t('readOnly')}>
                          {t('readOnly')}
                        </span>
                      )}
                    </label>
                  )}
                  <div className="menu-anchor">
                    <button
                      type="button"
                      className="icon-btn cal-cal-more"
                      data-menu-button
                      title={t('calendarOptions', { name: cal.name })}
                      aria-label={t('calendarOptions', { name: cal.name })}
                      aria-haspopup="menu"
                      aria-expanded={menu?.kind === 'calendar' && menu.id === cal.id}
                      onClick={() =>
                        setMenu(
                          menu?.kind === 'calendar' && menu.id === cal.id
                            ? null
                            : { kind: 'calendar', id: cal.id },
                        )
                      }
                    >
                      <IconMore />
                    </button>
                    {menu?.kind === 'calendar' && menu.id === cal.id && calendarMenu(cal)}
                  </div>
                </li>
              ))}
              {source && creating?.sourceId === source.id && (
                <li className="cal-cal">
                  <input
                    className="cal-inline-input"
                    value={creating.value}
                    autoFocus
                    placeholder={t('newCalendarName')}
                    aria-label={t('newCalendarName')}
                    onChange={(e) => setCreating({ sourceId: source.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void finishCreate(true)
                      else if (e.key === 'Escape') {
                        e.stopPropagation()
                        void finishCreate(false)
                      }
                    }}
                    onBlur={() => void finishCreate(true)}
                  />
                </li>
              )}
              {list.length === 0 && !(source && creating?.sourceId === source.id) && (
                <li className="cal-none">{t('noCalendars')}</li>
              )}
            </ul>
          </div>
        ))}
      </section>

      <div className="cal-sidebar-actions">
        <button type="button" className="add-account" onClick={props.onAddSource}>
          <IconPlus /> {t('addCalendar')}
        </button>
        {localSource && (
          <button type="button" className="add-account" onClick={() => startCreate(localSource.id)}>
            <IconPlus /> {t('newCalendar')}
          </button>
        )}
      </div>
    </div>
  )
}
