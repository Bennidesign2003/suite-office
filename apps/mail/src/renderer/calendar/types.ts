import type { CalendarEvent, CalendarInfo, EventInput } from '../../shared/pim'

/**
 * What the calendar view hands its Suite AI panel (calendar/CalendarAiPanel.tsx):
 * the visible period, what is in it, and a way to open the event editor
 * prefilled with a draft the AI produced.
 */
export interface CalendarAiContext {
  lang: string
  /** ISO instants of the visible period */
  visibleRange: { from: string; to: string }
  /** occurrences in the visible period, visible calendars only */
  events: CalendarEvent[]
  calendars: CalendarInfo[]
  selectedEvent: CalendarEvent | null
  /** where new events go unless the user picks another calendar */
  defaultCalendarId: string | null
  /** load occurrences of any period (e.g. "next week" for finding free time) */
  loadEvents(from: string, to: string): Promise<CalendarEvent[]>
  /** open the event editor with these fields filled in */
  openNewEvent(draft: Partial<EventInput>): void
}

/** the renderer-side translator shape every PIM module uses */
export type Translate<K extends string> = (key: K, vars?: Record<string, string>) => string
