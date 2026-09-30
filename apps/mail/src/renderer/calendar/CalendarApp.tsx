import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { MailAccountInfo } from '../../shared/ipc'
import type {
  CalendarEvent,
  CalendarInfo,
  EventInput,
  PimChange,
  PimSource,
} from '../../shared/pim'
import { IconClose, IconPlus, IconRefresh, SuiteMark } from '../components/icons'
import { SourceDialog } from '../pim/SourceDialog'
import { AgendaView } from './AgendaView'
import { CalendarSidebar } from './CalendarSidebar'
import {
  addDays,
  CALENDAR_VIEWS,
  dayCells,
  dayKey,
  eventSpan,
  fromIso,
  isValidDate,
  monthGrid,
  periodTitle,
  shiftAnchor,
  startOfDay,
  startOfMonth,
  viewRange,
  weekStartsOn,
  type CalendarView,
} from './dates'
import {
  EventDetails,
  IconArrowLeft,
  IconArrowRight,
  IconSidebar,
  IconWarning,
  ScopePrompt,
} from './EventDetails'
import { EventDialog, type EditorState } from './EventDialog'
import { calendarTranslator, type CalendarStringKey } from './i18n'
import { MonthView } from './MonthView'
import { TimeGridView } from './TimeGridView'
import type { CalendarAiContext } from './types'
import './calendar.css'

/**
 * The calendar module: Outlook's toolbar, a sidebar with the mini month and
 * the calendar list, and the day / work week / week / month / agenda views.
 * Data comes from window.pimApi; the view reloads when the period, the
 * visible calendars or anything in the main process changes.
 */

export interface CalendarAppProps {
  lang: string
  aiOpen: boolean
  onToggleAi(): void
  renderAiPanel?: (ctx: CalendarAiContext, close: () => void) => ReactNode
  request?: { kind: 'new-event'; draft: Partial<EventInput> } | null
  onRequestHandled?(): void
}

const VIEW_LABEL: Record<CalendarView, CalendarStringKey> = {
  day: 'viewDay',
  workweek: 'viewWorkweek',
  week: 'viewWeek',
  month: 'viewMonth',
  agenda: 'viewAgenda',
}

const VIEW_KEY = 'suite-mail.calendar.view'

function savedView(): CalendarView {
  try {
    const v = localStorage.getItem(VIEW_KEY) as CalendarView | null
    if (v && CALENDAR_VIEWS.includes(v)) return v
  } catch {
    // storage blocked: fall back to the default
  }
  return 'workweek'
}

function rememberView(view: CalendarView): void {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    // not worth an error
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** what the views rely on, whatever a sync or an old cache delivered */
function cleanEvent(e: CalendarEvent): CalendarEvent {
  return {
    ...e,
    title: typeof e.title === 'string' ? e.title : '',
    location: typeof e.location === 'string' ? e.location : '',
    description: typeof e.description === 'string' ? e.description : '',
    attendees: Array.isArray(e.attendees) ? e.attendees.filter((a) => a && a.email) : [],
    reminders: Array.isArray(e.reminders) ? e.reminders.filter(Number.isFinite) : [],
  }
}

const cleanEvents = (list: unknown): CalendarEvent[] =>
  Array.isArray(list) ? (list as CalendarEvent[]).filter((e) => e && e.id).map(cleanEvent) : []

/**
 * A rendering error in the calendar must not blank the whole mail window
 * (the modules share one React root); show it here and let the user retry.
 */
class CalendarBoundary extends Component<
  { message: string; retry: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="cal-crash" role="alert">
        <p>{this.props.message}</p>
        <p className="cal-crash-detail">{this.state.error.message}</p>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          {this.props.retry}
        </button>
      </div>
    )
  }
}

export function CalendarApp(props: CalendarAppProps): ReactElement {
  const t = useMemo(() => calendarTranslator(props.lang), [props.lang])
  // a stale preload or a host without the PIM bridge
  if (!window.pimApi) {
    return (
      <div className="cal-crash" role="alert">
        <p>{t('unavailable')}</p>
      </div>
    )
  }
  return (
    <CalendarBoundary message={t('crashed')} retry={t('retry')}>
      <CalendarModule {...props} />
    </CalendarBoundary>
  )
}

function CalendarModule({
  lang,
  aiOpen,
  onToggleAi,
  renderAiPanel,
  request,
  onRequestHandled,
}: CalendarAppProps): ReactElement {
  const t = useMemo(() => calendarTranslator(lang), [lang])
  const weekStart = useMemo(() => weekStartsOn(lang), [lang])

  const [view, setViewState] = useState<CalendarView>(savedView)
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()))
  const [now, setNow] = useState(() => new Date())
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const [calendars, setCalendars] = useState<CalendarInfo[] | null>(null)
  const [sources, setSources] = useState<PimSource[]>([])
  const [accounts, setAccounts] = useState<MailAccountInfo[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [changeTick, setChangeTick] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [syncingSourceId, setSyncingSourceId] = useState<string | null>(null)
  const [syncErrors, setSyncErrors] = useState<string[]>([])
  const [miniMonth, setMiniMonth] = useState(() => startOfMonth(new Date()))
  const [markedDays, setMarkedDays] = useState<ReadonlySet<string>>(new Set())

  const [selected, setSelected] = useState<{ event: CalendarEvent; rect: DOMRect } | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editorKey, setEditorKey] = useState(0)
  const [scopeAsk, setScopeAsk] = useState<{
    event: CalendarEvent
    action: 'edit' | 'delete'
  } | null>(null)
  const [sourceDialog, setSourceDialog] = useState<{ source?: PimSource } | null>(null)
  const [lastCalendarId, setLastCalendarId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)

  const eventsRequest = useRef(0)
  const marksRequest = useRef(0)
  const editorDirty = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const flash = useCallback((text: string, error = false) => {
    setNotice({ text, error })
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), error ? 8000 : 3500)
  }, [])

  const setView = useCallback((next: CalendarView) => {
    setViewState(next)
    rememberView(next)
  }, [])

  // ---- sources, calendars, accounts ----

  const loadCalendars = useCallback(async () => {
    try {
      const list = await window.pimApi.listCalendars()
      setCalendars(Array.isArray(list) ? list : [])
    } catch (err) {
      setCalendars((c) => c ?? [])
      flash(errorText(err), true)
    }
  }, [flash])

  const loadSources = useCallback(async () => {
    try {
      const list = await window.pimApi.listSources()
      setSources(Array.isArray(list) ? list : [])
    } catch {
      // the calendar list still works without the source headings
    }
  }, [])

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await window.mailApi.listAccounts())
    } catch {
      // no invitations without mail accounts; everything else works
    }
  }, [])

  useEffect(() => {
    void loadSources()
    void loadCalendars()
    void loadAccounts()
  }, [loadSources, loadCalendars, loadAccounts])

  useEffect(
    () =>
      window.pimApi.onChanged((change: PimChange) => {
        if (change.kind === 'calendar') {
          void loadCalendars()
          setChangeTick((n) => n + 1)
        } else if (change.kind === 'sources') {
          void loadSources()
          void loadCalendars()
        }
      }),
    [loadCalendars, loadSources],
  )

  // the red "now" line and today's highlight move on their own
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // ---- events of the visible period ----

  const range = useMemo(() => viewRange(view, anchor, weekStart), [view, anchor, weekStart])
  const rangeKey = `${range.start.toISOString()}|${range.end.toISOString()}`
  const calendarsLoaded = calendars !== null
  const visibleIds = useMemo(
    () => (calendars ?? []).filter((c) => c.visible).map((c) => c.id),
    [calendars],
  )
  const visibleKey = visibleIds.join('\n')

  const loadEvents = useCallback(async () => {
    const id = ++eventsRequest.current
    const ids = visibleKey ? visibleKey.split('\n') : []
    if (!ids.length) {
      setEvents([])
      setLoading(false)
      setLoadError('')
      return
    }
    const [from, to] = rangeKey.split('|') as [string, string]
    setLoading(true)
    try {
      const r = await window.pimApi.listEvents({ from, to, calendarIds: ids })
      // a later request (another period, a change) owns the view now
      if (id !== eventsRequest.current) return
      if (!r.ok) {
        setLoadError(r.error ?? '')
        return
      }
      setLoadError('')
      setEvents(cleanEvents(r.value))
    } catch (err) {
      if (id === eventsRequest.current) setLoadError(errorText(err))
    } finally {
      if (id === eventsRequest.current) setLoading(false)
    }
  }, [rangeKey, visibleKey])

  useEffect(() => {
    if (calendarsLoaded) void loadEvents()
  }, [calendarsLoaded, loadEvents, changeTick])

  // days with events, for the dots in the mini month
  useEffect(() => {
    if (!calendarsLoaded) return
    const id = ++marksRequest.current
    const ids = visibleKey ? visibleKey.split('\n') : []
    if (!ids.length) {
      setMarkedDays(new Set())
      return
    }
    const first = monthGrid(miniMonth, weekStart)[0]!
    const count = 42
    window.pimApi
      .listEvents({
        from: first.toISOString(),
        to: addDays(first, count).toISOString(),
        calendarIds: ids,
      })
      .then((r) => {
        if (id !== marksRequest.current || !r.ok || !r.value) return
        const marks = new Set<string>()
        for (const ev of r.value) {
          if (ev.status === 'cancelled') continue
          const cells = dayCells(eventSpan(ev), first, count)
          if (!cells) continue
          for (let i = cells.start; i < cells.end; i++) marks.add(dayKey(addDays(first, i)))
        }
        setMarkedDays(marks)
      })
      .catch(() => undefined)
  }, [calendarsLoaded, miniMonth, weekStart, visibleKey, changeTick])

  // the mini month follows the main view
  useEffect(() => setMiniMonth(startOfMonth(anchor)), [anchor])

  const visibleSet = useMemo(() => new Set(visibleIds), [visibleIds])
  const visibleEvents = useMemo(
    () => events.filter((e) => visibleSet.has(e.calendarId)),
    [events, visibleSet],
  )
  const colors = useMemo(
    () => new Map((calendars ?? []).map((c) => [c.id, c.color] as const)),
    [calendars],
  )
  const calendarById = useMemo(
    () => new Map((calendars ?? []).map((c) => [c.id, c] as const)),
    [calendars],
  )

  // keep the open popover on the reloaded copy of its event, or close it
  useEffect(() => {
    setSelected((sel) => {
      if (!sel) return sel
      const fresh = events.find((e) => e.id === sel.event.id)
      if (!fresh) return null
      return fresh === sel.event ? sel : { ...sel, event: fresh }
    })
  }, [events])

  const writable = useMemo(() => (calendars ?? []).filter((c) => !c.readOnly), [calendars])
  const defaultCalendarId =
    (lastCalendarId && writable.some((c) => c.id === lastCalendarId) ? lastCalendarId : null) ??
    writable.find((c) => c.visible)?.id ??
    writable[0]?.id ??
    null

  // ---- navigation ----

  const goToday = useCallback(() => {
    setSelected(null)
    setAnchor(startOfDay(new Date()))
  }, [])

  const step = useCallback(
    (dir: 1 | -1) => {
      setSelected(null)
      setAnchor((a) => shiftAnchor(view, a, dir))
    },
    [view],
  )

  const openDay = useCallback(
    (day: Date) => {
      setSelected(null)
      setAnchor(startOfDay(day))
      setView('day')
    },
    [setView],
  )

  // ---- editing ----

  const rangeRef = useRef(range)
  rangeRef.current = range

  const startEditor = useCallback(
    (state: EditorState): boolean => {
      if (editorDirty.current && !window.confirm(t('discardChanges'))) return false
      editorDirty.current = false
      setSelected(null)
      setScopeAsk(null)
      setEditorKey((k) => k + 1)
      setEditor(state)
      void loadAccounts()
      return true
    },
    [t, loadAccounts],
  )

  const openCreate = useCallback(
    (draft: Partial<EventInput>) => {
      if (!startEditor({ mode: 'create', draft })) return
      // show the day the draft is about (Suite AI, invitations)
      const start = fromIso(draft.start)
      const shown = rangeRef.current
      if (isValidDate(start) && (start < shown.start || start >= shown.end))
        setAnchor(startOfDay(start))
    },
    [startEditor],
  )

  const createAt = useCallback(
    (start: Date, end: Date, allDay: boolean) =>
      openCreate({
        start: allDay ? dayKey(start) : start.toISOString(),
        end: allDay ? dayKey(end) : end.toISOString(),
        allDay,
      }),
    [openCreate],
  )

  const newEvent = useCallback(() => {
    const today = startOfDay(new Date())
    const day = anchor >= range.start && anchor < range.end ? anchor : range.start
    if (day.getTime() === today.getTime()) {
      openCreate({})
      return
    }
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9)
    openCreate({
      start: start.toISOString(),
      end: new Date(start.getTime() + 3_600_000).toISOString(),
    })
  }, [anchor, range, openCreate])

  const openEdit = useCallback(
    (event: CalendarEvent) => {
      if (event.readOnly || calendarById.get(event.calendarId)?.readOnly) return
      setSelected(null)
      if (event.recurring) setScopeAsk({ event, action: 'edit' })
      else startEditor({ mode: 'edit', event })
    },
    [calendarById, startEditor],
  )

  const removeEvent = useCallback(
    async (event: CalendarEvent, scope?: 'occurrence' | 'series') => {
      setSelected(null)
      // gone from the view at once; a failed delete brings it back with the reload
      setEvents((list) =>
        list.filter((e) =>
          scope === 'series'
            ? !(e.calendarId === event.calendarId && e.uid === event.uid)
            : e.id !== event.id,
        ),
      )
      try {
        const r = await window.pimApi.deleteEvent(
          event.calendarId,
          event.uid,
          scope,
          scope === 'occurrence' ? (event.occurrenceStart ?? event.start) : undefined,
        )
        if (!r.ok) flash(r.error ?? '', true)
        else flash(t('deleted'))
      } catch (err) {
        flash(errorText(err), true)
      }
      setChangeTick((n) => n + 1)
    },
    [flash, t],
  )

  const requestDelete = useCallback(
    (event: CalendarEvent) => {
      if (event.readOnly || calendarById.get(event.calendarId)?.readOnly) return
      if (event.recurring) {
        setSelected(null)
        setScopeAsk({ event, action: 'delete' })
      } else if (
        window.confirm(t('deleteConfirm', { title: event.title.trim() || t('noTitle') }))
      ) {
        void removeEvent(event)
      }
    },
    [calendarById, removeEvent, t],
  )

  const chooseScope = async (scope: 'occurrence' | 'series'): Promise<void> => {
    const ask = scopeAsk
    setScopeAsk(null)
    if (!ask) return
    if (ask.action === 'delete') {
      void removeEvent(ask.event, scope)
      return
    }
    if (scope === 'occurrence') {
      startEditor({ mode: 'edit', event: ask.event, scope })
      return
    }
    // the series is edited from its own first occurrence, not the one clicked
    try {
      const r = await window.pimApi.getEvent(ask.event.calendarId, ask.event.uid)
      if (!r.ok || !r.value) {
        flash(r.error ?? t('loadFailed'), true)
        return
      }
      startEditor({ mode: 'edit', event: cleanEvent(r.value), scope: 'series' })
    } catch (err) {
      flash(errorText(err), true)
    }
  }

  const closeEditor = useCallback(() => {
    editorDirty.current = false
    setEditor(null)
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const onSaved = (event: CalendarEvent, invited: boolean): void => {
    closeEditor()
    setLastCalendarId(event.calendarId)
    flash(t(invited ? 'savedInvites' : 'saved'))
    const start = eventSpan(event).start
    if (isValidDate(start) && (start < range.start || start >= range.end))
      setAnchor(startOfDay(start))
    setChangeTick((n) => n + 1)
  }

  // "new event" handed over by the mail module or Suite AI
  useEffect(() => {
    if (request?.kind !== 'new-event') return
    openCreate(request.draft)
    onRequestHandled?.()
  }, [request, openCreate, onRequestHandled])

  // ---- calendars & sources ----

  const updateCalendar = useCallback(
    async (id: string, patch: { color?: string; visible?: boolean; name?: string }) => {
      setCalendars((list) => list?.map((c) => (c.id === id ? { ...c, ...patch } : c)) ?? list)
      try {
        const r = await window.pimApi.updateCalendar(id, patch)
        if (!r.ok) {
          flash(r.error ?? '', true)
          void loadCalendars()
        }
      } catch (err) {
        flash(errorText(err), true)
        void loadCalendars()
      }
    },
    [flash, loadCalendars],
  )

  const showOnly = (cal: CalendarInfo): void => {
    for (const c of calendars ?? []) {
      const visible = c.id === cal.id
      if (c.visible !== visible) void updateCalendar(c.id, { visible })
    }
  }

  const importInto = async (cal: CalendarInfo): Promise<void> => {
    try {
      const r = await window.pimApi.importIcs(cal.id)
      if (!r.ok) flash(r.error ?? '', true)
      else if (r.value) {
        flash(t('imported', { n: String(r.value) }))
        setChangeTick((n) => n + 1)
      }
    } catch (err) {
      flash(errorText(err), true)
    }
  }

  const exportFrom = async (cal: CalendarInfo): Promise<void> => {
    try {
      const r = await window.pimApi.exportIcs(cal.id)
      if (!r.ok) flash(r.error ?? '', true)
      else if (r.value) flash(t('exported', { path: r.value }))
    } catch (err) {
      flash(errorText(err), true)
    }
  }

  const createCalendar = async (
    sourceId: string,
    name: string,
    color: string,
  ): Promise<boolean> => {
    try {
      const r = await window.pimApi.createCalendar(sourceId, name, color)
      if (!r.ok) {
        flash(r.error ?? '', true)
        return false
      }
      if (r.value) setLastCalendarId(r.value.id)
      void loadCalendars()
      return true
    } catch (err) {
      flash(errorText(err), true)
      return false
    }
  }

  const removeSource = async (source: PimSource): Promise<void> => {
    if (!window.confirm(t('removeSourceConfirm', { name: source.name }))) return
    try {
      await window.pimApi.removeSource(source.id)
    } catch (err) {
      flash(errorText(err), true)
    }
    void loadSources()
    void loadCalendars()
  }

  const syncSource = async (source: PimSource): Promise<void> => {
    setSyncingSourceId(source.id)
    try {
      const r = await window.pimApi.sync(source.id)
      if (!r.ok) flash(`${source.name}: ${r.error ?? ''}`, true)
    } catch (err) {
      flash(errorText(err), true)
    } finally {
      setSyncingSourceId(null)
    }
    void loadSources()
    void loadCalendars()
    setChangeTick((n) => n + 1)
  }

  const syncAll = async (): Promise<void> => {
    if (syncing) return
    setSyncing(true)
    setSyncErrors([])
    try {
      const r = await window.pimApi.sync()
      if (!r.ok) setSyncErrors((r.error ?? '').split('\n').filter(Boolean))
    } catch (err) {
      setSyncErrors([errorText(err)])
    } finally {
      setSyncing(false)
    }
    void loadSources()
    void loadCalendars()
    setChangeTick((n) => n + 1)
  }

  // ---- Suite AI ----

  const aiContext = useMemo<CalendarAiContext>(
    () => ({
      lang,
      visibleRange: { from: range.start.toISOString(), to: range.end.toISOString() },
      events: visibleEvents,
      calendars: calendars ?? [],
      selectedEvent: selected?.event ?? null,
      defaultCalendarId,
      loadEvents: async (from, to) => {
        if (!visibleIds.length) return []
        const r = await window.pimApi.listEvents({ from, to, calendarIds: visibleIds })
        if (!r.ok) throw new Error(r.error || t('loadFailed'))
        return cleanEvents(r.value).filter((e) => visibleSet.has(e.calendarId))
      },
      openNewEvent: (draft) => openCreate(draft),
    }),
    [
      lang,
      range,
      visibleEvents,
      calendars,
      selected,
      defaultCalendarId,
      visibleIds,
      visibleSet,
      t,
      openCreate,
    ],
  )

  // ---- keyboard (on our own root: the module stays mounted while hidden) ----

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (editor || scopeAsk || sourceDialog || e.defaultPrevented) return
    const el = e.target as HTMLElement
    if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
    if ((e.ctrlKey || e.metaKey) && e.altKey && /^[1-5]$/.test(e.key)) {
      e.preventDefault()
      setSelected(null)
      setView(CALENDAR_VIEWS[Number(e.key) - 1]!)
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    switch (e.key) {
      case 'Escape':
        if (selected) setSelected(null)
        return
      case 'n':
      case 'N':
        e.preventDefault()
        newEvent()
        return
      case 't':
      case 'T':
        goToday()
        return
      case 'ArrowLeft':
      case 'PageUp':
        if (el.closest('.cal-views')) return
        e.preventDefault()
        step(-1)
        return
      case 'ArrowRight':
      case 'PageDown':
        if (el.closest('.cal-views')) return
        e.preventDefault()
        step(1)
        return
    }
  }

  // ---- render ----

  const mod = navigator.platform.startsWith('Mac') ? '⌘' : lang.startsWith('de') ? 'Strg' : 'Ctrl'
  const title = periodTitle(view, anchor, weekStart, lang)
  const withAi = aiOpen && !!renderAiPanel
  const selectEvent = (event: CalendarEvent, rect: DOMRect): void => setSelected({ event, rect })

  const viewProps = {
    t,
    lang,
    events: visibleEvents,
    colors,
    now,
    selectedId: selected?.event.id ?? null,
    onSelect: selectEvent,
    onOpen: openEdit,
  }

  return (
    <div
      ref={rootRef}
      className={`cal-app${withAi ? ' with-ai' : ''}${sidebarOpen ? '' : ' no-sidebar'}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="mail-toolbar cal-toolbar">
        <button
          type="button"
          className={`tool${sidebarOpen ? ' on' : ''}`}
          title={t('toggleSidebar')}
          aria-label={t('toggleSidebar')}
          aria-pressed={sidebarOpen}
          onClick={() => setSidebarOpen((o) => !o)}
        >
          <IconSidebar />
        </button>
        <button
          type="button"
          className="btn btn-primary"
          title={`${t('newEventLong')} (N)`}
          onClick={newEvent}
        >
          <IconPlus /> {t('newEvent')}
        </button>
        <span className="sep" />
        <button
          type="button"
          className="btn cal-today"
          title={`${t('today')} (T)`}
          onClick={goToday}
        >
          {t('today')}
        </button>
        <button
          type="button"
          className="icon-btn cal-step"
          title={t('previous')}
          aria-label={t('previous')}
          onClick={() => step(-1)}
        >
          <IconArrowLeft />
        </button>
        <button
          type="button"
          className="icon-btn cal-step"
          title={t('next')}
          aria-label={t('next')}
          onClick={() => step(1)}
        >
          <IconArrowRight />
        </button>
        <h1 className="cal-period" aria-live="polite" title={t('shortcutHint', { key: mod })}>
          {title}
        </h1>
        <span className="spacer" />
        <div className="cal-views" role="group" aria-label={t('views')}>
          {CALENDAR_VIEWS.map((v, i) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              title={`${t(VIEW_LABEL[v])} (${mod}+Alt+${i + 1})`}
              onClick={() => {
                setSelected(null)
                setView(v)
              }}
            >
              {t(VIEW_LABEL[v])}
            </button>
          ))}
        </div>
        <span className="sep" />
        <button
          type="button"
          className={`tool cal-sync${syncing ? ' spinning' : ''}`}
          disabled={syncing}
          title={syncing ? t('syncing') : t('refresh')}
          aria-label={syncing ? t('syncing') : t('refresh')}
          onClick={() => void syncAll()}
        >
          <IconRefresh />
        </button>
        {renderAiPanel && (
          <button
            type="button"
            className={`tool ai-toggle${aiOpen ? ' on' : ''}`}
            aria-pressed={aiOpen}
            onClick={onToggleAi}
          >
            <SuiteMark size={18} /> <span>{t('aiToggle')}</span>
          </button>
        )}
      </header>

      <nav className="cal-sidebar" aria-label={t('calendars')} hidden={!sidebarOpen}>
        <CalendarSidebar
          t={t}
          lang={lang}
          weekStart={weekStart}
          now={now}
          miniMonth={miniMonth}
          onMiniMonth={setMiniMonth}
          range={range}
          markedDays={markedDays}
          calendars={calendars ?? []}
          sources={sources}
          syncingSourceId={syncingSourceId}
          onPickDay={(day) => {
            setSelected(null)
            setAnchor(startOfDay(day))
          }}
          onUpdateCalendar={(id, patch) => void updateCalendar(id, patch)}
          onShowOnly={showOnly}
          onImport={(cal) => void importInto(cal)}
          onExport={(cal) => void exportFrom(cal)}
          onCreateCalendar={createCalendar}
          onAddSource={() => setSourceDialog({})}
          onEditSource={(source) => setSourceDialog({ source })}
          onRemoveSource={(source) => void removeSource(source)}
          onSyncSource={(source) => void syncSource(source)}
        />
      </nav>

      <main className="cal-main" aria-busy={loading}>
        {loading && <div className="cal-progress" role="progressbar" aria-label={t('loading')} />}
        {syncErrors.length > 0 && (
          <div className="cal-banner" role="alert">
            <IconWarning />
            <div className="cal-banner-text">
              <strong>{t('syncFailed')}</strong>
              {syncErrors.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
            <button
              type="button"
              className="icon-btn"
              title={t('dismiss')}
              aria-label={t('dismiss')}
              onClick={() => setSyncErrors([])}
            >
              <IconClose />
            </button>
          </div>
        )}
        {loadError && (
          <div className="cal-banner" role="alert">
            <IconWarning />
            <div className="cal-banner-text">
              <strong>{t('loadFailed')}</strong>
              <div>{loadError}</div>
            </div>
            <button type="button" className="link-btn" onClick={() => void loadEvents()}>
              {t('retry')}
            </button>
          </div>
        )}
        {calendars !== null && calendars.length > 0 && visibleIds.length === 0 && (
          <div className="cal-banner cal-banner-info">{t('noCalendarsVisible')}</div>
        )}

        {view === 'month' ? (
          <MonthView
            {...viewProps}
            weekStart={weekStart}
            days={range.days}
            month={anchor}
            onOpenDay={openDay}
            onCreate={createAt}
          />
        ) : view === 'agenda' ? (
          <AgendaView {...viewProps} days={range.days} calendars={calendarById} />
        ) : (
          <TimeGridView {...viewProps} days={range.days} onCreate={createAt} onOpenDay={openDay} />
        )}
      </main>

      {withAi && <div className="cal-ai-host">{renderAiPanel!(aiContext, onToggleAi)}</div>}

      {selected && (
        <EventDetails
          t={t}
          lang={lang}
          weekStart={weekStart}
          event={selected.event}
          calendar={calendarById.get(selected.event.calendarId)}
          anchor={selected.rect}
          onClose={() => setSelected(null)}
          onEdit={() => openEdit(selected.event)}
          onDelete={() => requestDelete(selected.event)}
        />
      )}

      {scopeAsk && (
        <ScopePrompt
          t={t}
          title={scopeAsk.event.title}
          action={scopeAsk.action}
          onChoose={(scope) => void chooseScope(scope)}
          onCancel={() => setScopeAsk(null)}
        />
      )}

      {editor && (
        <EventDialog
          key={editorKey}
          t={t}
          lang={lang}
          weekStart={weekStart}
          state={editor}
          calendars={calendars ?? []}
          accounts={accounts}
          defaultCalendarId={defaultCalendarId}
          onDirtyChange={(dirty) => {
            editorDirty.current = dirty
          }}
          onClose={closeEditor}
          onSaved={onSaved}
        />
      )}

      {sourceDialog && (
        <SourceDialog
          lang={lang}
          kinds={['caldav', 'ics']}
          source={sourceDialog.source}
          onClose={() => setSourceDialog(null)}
          onSaved={() => {
            setSourceDialog(null)
            void loadSources()
            void loadCalendars()
            setChangeTick((n) => n + 1)
          }}
        />
      )}

      {notice && (
        <div className={`toast${notice.error ? ' toast-error' : ''}`} role="status">
          {notice.error ? `${t('errorPrefix')}: ` : ''}
          {notice.text}
        </div>
      )}
    </div>
  )
}
