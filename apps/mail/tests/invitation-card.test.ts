// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarInfo, Invitation } from '../src/shared/pim'
import { describeRrule, formatWhen } from '../src/renderer/calendar/ai-i18n'
import type { CalendarAiContext } from '../src/renderer/calendar/types'
import { InvitationCard } from '../src/renderer/components/InvitationCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const local = (y: number, m: number, d: number, h = 0, min = 0): string =>
  new Date(y, m - 1, d, h, min).toISOString()

const CALENDARS: CalendarInfo[] = [
  {
    id: 'icloud:work',
    sourceId: 'icloud',
    name: 'Arbeit',
    color: '#d13438',
    visible: true,
    readOnly: false,
  },
  {
    id: 'local:default',
    sourceId: 'local',
    name: 'Kalender',
    color: '#0f6cbd',
    visible: true,
    readOnly: false,
  },
  {
    id: 'ics:holidays',
    sourceId: 'ics',
    name: 'Feiertage',
    color: '#107c41',
    visible: true,
    readOnly: true,
  },
]

function invitation(partial: Partial<Invitation> = {}): Invitation {
  return {
    method: 'REQUEST',
    uid: 'meeting-1@example.org',
    sequence: 0,
    title: 'Projekt-Kickoff',
    location: 'Raum 4.12',
    description: '',
    start: local(2026, 10, 1, 15),
    end: local(2026, 10, 1, 16),
    allDay: false,
    organizer: { name: 'Anna Schmidt', email: 'anna@firma.de' },
    attendees: [
      { name: 'Anna Schmidt', email: 'anna@firma.de', status: 'accepted' },
      { name: 'Ben', email: 'ben@firma.de', status: 'declined' },
      { email: 'carl@firma.de', status: 'tentative', optional: true },
      { email: 'dora@firma.de', status: 'needs-action' },
      { email: 'emil@firma.de', status: 'needs-action' },
      { email: 'fritz@firma.de', status: 'needs-action' },
      { email: 'me@example.org', status: 'needs-action' },
    ],
    ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    ...partial,
  }
}

let root: Root | null = null
let host: HTMLElement | null = null

type CardProps = Parameters<typeof InvitationCard>[0]

function render(props: Partial<CardProps> & { invitation: Invitation }): {
  el: HTMLElement
  onRespond: ReturnType<typeof vi.fn>
  onRemove: ReturnType<typeof vi.fn>
  rerender(next: Partial<CardProps>): void
} {
  const onRespond = vi.fn()
  const onRemove = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const base: CardProps = { lang: 'de', calendars: CALENDARS, onRespond, onRemove, ...props }
  act(() => root!.render(createElement(InvitationCard, base)))
  return {
    el: host,
    onRespond,
    onRemove,
    rerender(next) {
      act(() => root!.render(createElement(InvitationCard, { ...base, ...next })))
    },
  }
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no button "${label}" in: ${el.textContent}`)
  return found
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('InvitationCard', () => {
  it('shows a request with date, place, organizer and the collapsed attendee list', () => {
    const { el } = render({ invitation: invitation() })
    const text = el.textContent ?? ''
    expect(text).toContain('Einladung')
    expect(el.querySelector('h3')?.textContent).toBe('Projekt-Kickoff')
    expect(text).toContain('Donnerstag, 1. Oktober 2026')
    expect(text).toMatch(/15:00\s*–\s*16:00/)
    expect(text).toContain('Raum 4.12')
    expect(text).toContain('Anna Schmidt')
    expect(text).toContain('Teilnehmer (7)')
    expect(text).toContain('1 zugesagt, 1 mit Vorbehalt, 1 abgelehnt, 4 ohne Antwort')
    expect(el.querySelectorAll('.invite-people li')).toHaveLength(5)
    expect(el.querySelector('.invite-status.is-declined')?.getAttribute('aria-label')).toBe(
      'Abgelehnt',
    )
    expect(text).toContain('optional')

    click(button(el, 'Alle 7 anzeigen'))
    expect(el.querySelectorAll('.invite-people li')).toHaveLength(7)
    click(button(el, 'Weniger anzeigen'))
    expect(el.querySelectorAll('.invite-people li')).toHaveLength(5)
  })

  it('offers only writable calendars, defaults to the local one and reports the answer', () => {
    const { el, onRespond } = render({ invitation: invitation() })
    const select = el.querySelector('select')!
    expect([...select.options].map((o) => o.value)).toEqual(['icloud:work', 'local:default'])
    expect(select.value).toBe('local:default')

    click(button(el, 'Zusagen'))
    expect(onRespond).toHaveBeenLastCalledWith('accepted', 'local:default')

    act(() => {
      select.value = 'icloud:work'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click(button(el, 'Mit Vorbehalt'))
    expect(onRespond).toHaveBeenLastCalledWith('tentative', 'icloud:work')

    click(button(el, 'Ablehnen'))
    expect(onRespond).toHaveBeenLastCalledWith('declined', undefined)
    expect(onRespond).toHaveBeenCalledTimes(3)
  })

  it('keeps an update in the calendar that already holds the meeting', () => {
    const { el, onRespond } = render({ invitation: invitation({ existingEventId: 'icloud:work' }) })
    expect(el.textContent).toContain('Bereits im Kalender „Arbeit“.')
    expect(el.querySelector('select')!.value).toBe('icloud:work')
    click(button(el, 'Zusagen'))
    expect(onRespond).toHaveBeenCalledWith('accepted', 'icloud:work')
  })

  it('picks a calendar once the list arrives and locks the buttons while busy', () => {
    const view = render({ invitation: invitation(), calendars: [] })
    expect(view.el.querySelector('select')).toBeNull()
    click(button(view.el, 'Zusagen'))
    expect(view.onRespond).toHaveBeenLastCalledWith('accepted', undefined)

    view.rerender({ calendars: CALENDARS, busy: true })
    expect(view.el.querySelector('select')!.value).toBe('local:default')
    for (const label of ['Zusagen', 'Mit Vorbehalt', 'Ablehnen']) {
      expect(button(view.el, label).disabled).toBe(true)
    }
    expect(view.el.querySelector('section')?.getAttribute('aria-busy')).toBe('true')
  })

  it('still lets the user decline when no calendar is writable', () => {
    const { el } = render({ invitation: invitation(), calendars: [CALENDARS[2]!] })
    expect(el.textContent).toContain('keinen Kalender, in den Suite Office schreiben darf')
    expect(button(el, 'Zusagen').disabled).toBe(true)
    expect(button(el, 'Ablehnen').disabled).toBe(false)
  })

  it('shows a cancellation and removes the filed meeting on request', () => {
    const { el, onRemove, onRespond } = render({
      invitation: invitation({ method: 'CANCEL', existingEventId: 'local:default' }),
    })
    expect(el.textContent).toContain('Absage')
    expect(el.textContent).toContain('Dieser Termin wurde abgesagt.')
    expect(el.querySelector('.invite-card')?.classList.contains('is-cancel')).toBe(true)
    click(button(el, 'Aus Kalender entfernen'))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRespond).not.toHaveBeenCalled()
    expect(el.textContent).not.toContain('Zusagen')
  })

  it('offers no removal for a cancellation that is not in the calendar', () => {
    const { el } = render({ invitation: invitation({ method: 'CANCEL' }) })
    expect(el.textContent).toContain('Der Termin ist nicht in deinem Kalender.')
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Aus Kalender entfernen',
    )
  })

  it('says who answered a reply', () => {
    const reply = invitation({
      method: 'REPLY',
      replyStatus: 'accepted',
      attendees: [{ name: 'Ben', email: 'ben@firma.de', status: 'accepted' }],
      existingEventId: 'local:default',
    })
    const view = render({ invitation: reply })
    expect(view.el.textContent).toContain('Ben hat zugesagt.')
    expect(view.el.textContent).toContain('Die Antwort ist in deinem Kalender vermerkt.')
    expect(view.el.querySelector('.invite-people')).toBeNull()
    expect(view.el.querySelectorAll('.invite-actions button')).toHaveLength(0)

    view.rerender({
      lang: 'en',
      invitation: {
        ...reply,
        replyStatus: 'declined',
        attendees: [{ email: 'ben@firma.de', status: 'declined' }],
      },
    })
    expect(view.el.textContent).toContain('ben@firma.de declined.')
  })

  it('adds a published event to the chosen calendar', () => {
    const { el, onRespond } = render({
      invitation: invitation({ method: 'PUBLISH', attendees: [] }),
    })
    expect(el.textContent).not.toContain('Zusagen')
    click(button(el, 'Zum Kalender hinzufügen'))
    expect(onRespond).toHaveBeenCalledWith('accepted', 'local:default')
  })

  it('renders all-day, recurring events and falls back to English for other languages', () => {
    const { el } = render({
      lang: 'fr',
      invitation: invitation({
        allDay: true,
        start: '2026-10-12',
        end: '2026-10-15',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
      }),
    })
    const text = el.textContent ?? ''
    expect(text).toContain('Invitation')
    expect(text).toContain('Accept')
    expect(text).toContain('all day')
    expect(text).toMatch(/12.*14 oct\. 2026/)
    expect(text).toContain('every Monday and Wednesday')
  })

  it('opens the calendar from the card', () => {
    const onOpenCalendar = vi.fn()
    const { el } = render({ invitation: invitation(), onOpenCalendar })
    click(button(el, 'Kalender öffnen'))
    expect(onOpenCalendar).toHaveBeenCalledTimes(1)
  })

  it('survives a malformed invitation', () => {
    const { el } = render({
      invitation: {
        ...invitation(),
        title: '',
        location: undefined as unknown as string,
        start: 'not a date',
        end: '',
        attendees: undefined as unknown as Invitation['attendees'],
        organizer: undefined,
      },
    })
    expect(el.querySelector('h3')?.textContent).toBe('(ohne Titel)')
    expect(el.textContent).toContain('Zusagen')
  })
})

describe('invitation phrases', () => {
  it('describes common recurrence rules in German and English', () => {
    expect(describeRrule('FREQ=DAILY', 'de')).toBe('täglich')
    expect(describeRrule('FREQ=DAILY;INTERVAL=3', 'en')).toBe('every 3 days')
    expect(describeRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'de')).toBe('jeden Werktag (Mo–Fr)')
    expect(describeRrule('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=10', 'en')).toBe(
      'every 2 weeks on Friday, 10 times',
    )
    expect(describeRrule('FREQ=WEEKLY;BYDAY=MO,WE,FR', 'de')).toBe(
      'jeden Montag, Mittwoch und Freitag',
    )
    expect(describeRrule('FREQ=MONTHLY;BYDAY=1MO', 'de')).toBe('monatlich am ersten Montag')
    expect(describeRrule('FREQ=MONTHLY;BYDAY=TH;BYSETPOS=-1', 'en')).toBe(
      'monthly on the last Thursday',
    )
    expect(describeRrule('FREQ=MONTHLY;BYMONTHDAY=15', 'de')).toBe('monatlich am 15.')
    expect(describeRrule('FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=3', 'de')).toBe(
      'jährlich am 3. Oktober',
    )
    expect(describeRrule('FREQ=WEEKLY;UNTIL=20261231', 'de')).toBe(
      'wöchentlich, bis 31. Dezember 2026',
    )
    expect(describeRrule('FREQ=HOURLY', 'de')).toBe('wiederkehrend')
    expect(describeRrule(undefined, 'de')).toBe('')
  })

  it('formats timed, all-day and broken ranges without throwing', () => {
    expect(formatWhen('2026-10-01', '2026-10-02', true, 'de')).toBe(
      'Donnerstag, 1. Oktober 2026 · ganztägig',
    )
    expect(formatWhen('2026-10-01', '2026-10-04', true, 'en').replace(/\s/g, ' ')).toBe(
      'Thu, Oct 1 – Sat, Oct 3, 2026 · all day',
    )
    expect(
      formatWhen(local(2026, 10, 1, 22), local(2026, 10, 2, 1), false, 'de').replace(/\s/g, ' '),
    ).toMatch(/1\. Okt\. 2026, 22:00 – .*2\. Okt\. 2026, 01:00/)
    expect(formatWhen('bad', 'worse', false, 'de')).toBe('')
    expect(formatWhen('bad', '', true, 'de')).toBe('')
    expect(
      formatWhen(local(2026, 10, 1, 9), local(2026, 10, 1, 10), false, 'x-invalid-'),
    ).toContain('2026')
  })
})

// ---- the calendar's Suite AI panel (same jsdom setup) ----

describe('CalendarAiPanel', () => {
  type Chunk = { requestId: string; type: string; text?: string }
  let answer = ''
  let model = 'qwen3:4b'
  const streamed = vi.fn()

  function installMailApi(): void {
    const listeners = new Set<(chunk: Chunk) => void>()
    ;(window as unknown as { mailApi: unknown }).mailApi = {
      getAiSettings: async () => ({ provider: 'ollama', providers: { ollama: { model } } }),
      aiStream: async (request: { requestId: string; system: string }) => {
        streamed(request)
        queueMicrotask(() => {
          for (const l of listeners)
            l({ requestId: request.requestId, type: 'delta', text: answer })
          for (const l of listeners) l({ requestId: request.requestId, type: 'done' })
        })
      },
      aiStreamCancel: async () => undefined,
      onAiStream: (handler: (chunk: Chunk) => void) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
    }
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve())
  }

  async function renderPanel(overrides: Partial<CalendarAiContext> = {}) {
    const { CalendarAiPanel } = await import('../src/renderer/calendar/CalendarAiPanel')
    const ctx: CalendarAiContext = {
      lang: 'de',
      visibleRange: { from: local(2026, 9, 28), to: local(2026, 10, 5) },
      events: [],
      calendars: CALENDARS,
      selectedEvent: null,
      defaultCalendarId: 'local:default',
      loadEvents: vi.fn(async () => [
        {
          id: 'h',
          uid: 'h',
          calendarId: 'ics:holidays',
          title: 'Feiertag',
          location: '',
          description: '',
          start: '2026-10-01',
          end: '2026-10-02',
          allDay: true,
          recurring: false,
          status: 'confirmed' as const,
          attendees: [],
          reminders: [],
          readOnly: true,
        },
        {
          id: 'm',
          uid: 'm',
          calendarId: 'local:default',
          title: 'Meeting',
          location: '',
          description: '',
          start: local(2026, 9, 30, 14),
          end: local(2026, 9, 30, 17),
          allDay: false,
          recurring: false,
          status: 'confirmed' as const,
          attendees: [],
          reminders: [],
          readOnly: false,
        },
      ]),
      openNewEvent: vi.fn(),
      ...overrides,
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(CalendarAiPanel, { ctx, onClose: vi.fn() })))
    return { el: host, ctx }
  }

  function type(el: HTMLElement, text: string): void {
    const box = el.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(box, text)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 30, 13, 40))
    answer = ''
    model = 'qwen3:4b'
    streamed.mockReset()
    installMailApi()
  })

  afterEach(() => vi.useRealTimers())

  it('turns a description into a draft and opens the editor with it', async () => {
    answer =
      'Hier: ```json\n{"title": "Zahnarzt", "date": "2026-10-01", "start": "15:00", "end": null, "durationMinutes": 60, "allDay": false, "location": "Hauptstraße", "description": "", "attendees": [], "rrule": null}\n```'
    const { el, ctx } = await renderPanel()
    type(el, 'Zahnarzt Donnerstag 15 Uhr in der Hauptstraße')
    click(el.querySelector('button[type="submit"]')!)
    await flush()
    expect(streamed).toHaveBeenCalledTimes(1)
    expect(streamed.mock.calls[0]![0].system).toContain(
      '2026-10-01 Thursday / Donnerstag (tomorrow)',
    )
    expect(el.querySelector('.cal-ai-draft-title')?.textContent).toBe('Zahnarzt')
    expect(el.textContent).toContain('Hauptstraße')
    click(button(el, 'Termin anlegen'))
    expect(ctx.openNewEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'local:default',
        title: 'Zahnarzt',
        start: local(2026, 10, 1, 15),
        end: local(2026, 10, 1, 16),
        allDay: false,
      }),
    )
    expect(el.querySelector('.cal-ai-draft')).toBeNull()
  })

  it('says so when the answer holds no appointment, and when no model is set up', async () => {
    answer = 'Das verstehe ich leider nicht.'
    const { el } = await renderPanel()
    type(el, 'blabla')
    click(el.querySelector('button[type="submit"]')!)
    await flush()
    expect(el.querySelector('.ai-error')?.textContent).toContain('kein Termin ablesen')

    model = ''
    type(el, 'morgen 10 Uhr Friseur')
    click(el.querySelector('button[type="submit"]')!)
    await flush()
    expect(el.querySelector('.ai-error')?.textContent).toContain('Kein KI-Modell ausgewählt')
  })

  it('finds free time without AI and opens a slot', async () => {
    const { el, ctx } = await renderPanel()
    click(button(el, 'Freie Zeit finden'))
    await flush()
    expect(ctx.loadEvents).toHaveBeenCalledWith(local(2026, 9, 30, 13, 40), local(2026, 10, 7))
    expect(streamed).not.toHaveBeenCalled()
    // today is busy until 17:00; tomorrow's holiday is shown, not blocking
    const first = el.querySelector<HTMLButtonElement>('.cal-ai-slots button')!
    expect(first.textContent).toMatch(/17:00\s*–\s*18:00/)
    expect(el.textContent).toContain('Ganztägig: Feiertag')
    click(first)
    expect(ctx.openNewEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'local:default',
        start: local(2026, 9, 30, 17),
        end: local(2026, 9, 30, 18),
        allDay: false,
      }),
    )
    const before = el.querySelectorAll('.cal-ai-slots button').length
    const select = el.querySelector<HTMLSelectElement>('.cal-ai-free select')!
    act(() => {
      select.value = '120'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(el.querySelectorAll('.cal-ai-slots button').length).toBeLessThan(before)
  })

  it('answers "what is coming up" locally for an empty period and needs a selection to prepare', async () => {
    const { el } = await renderPanel()
    click(button(el, 'Was steht an?'))
    expect(el.querySelector('.ai-text')?.textContent).toBe(
      'Im angezeigten Zeitraum stehen keine Termine an.',
    )
    expect(streamed).not.toHaveBeenCalled()
    expect(button(el, 'Meeting vorbereiten').disabled).toBe(true)
  })
})
