/**
 * Calendar, contacts and meeting invitations — the "Outlook" half of the mail
 * module. Shared by the main process (apps/mail/src/main/pim/*) and the
 * renderer (apps/mail/src/renderer/{calendar,contacts}/*); exposed to the page
 * as `window.pimApi`.
 *
 * Times cross IPC as ISO 8601 strings. A timed event's start/end are instants
 * (UTC, ending in "Z"); an all-day event's start/end are dates
 * ("2026-10-01"), end exclusive, exactly like DTEND;VALUE=DATE in iCalendar.
 */

import type { MailResult } from './ipc'

export const PIM_CHANNELS = {
  // sources: where calendars / address books come from
  listSources: 'pim:list-sources',
  saveSource: 'pim:save-source',
  removeSource: 'pim:remove-source',
  testSource: 'pim:test-source',
  guessDav: 'pim:guess-dav',
  sync: 'pim:sync',

  // calendars
  listCalendars: 'pim:list-calendars',
  updateCalendar: 'pim:update-calendar',
  createCalendar: 'pim:create-calendar',
  listEvents: 'pim:list-events',
  getEvent: 'pim:get-event',
  saveEvent: 'pim:save-event',
  deleteEvent: 'pim:delete-event',
  importIcs: 'pim:import-ics',
  exportIcs: 'pim:export-ics',

  // contacts
  listAddressBooks: 'pim:list-address-books',
  listContacts: 'pim:list-contacts',
  saveContact: 'pim:save-contact',
  deleteContact: 'pim:delete-contact',
  importVcf: 'pim:import-vcf',
  exportVcf: 'pim:export-vcf',
  suggestAddresses: 'pim:suggest-addresses',
  rememberRecipients: 'pim:remember-recipients',

  // invitations in mail
  respondInvitation: 'pim:respond-invitation',

  /** main → renderer push: something changed after a sync or a write */
  changed: 'pim:changed',
} as const

// ---- sources ----

export type SourceKind =
  /** stored on this computer only */
  | 'local'
  /** a CalDAV server (iCloud, Nextcloud, Posteo, mailbox.org, GMX, WEB.DE, Fastmail …) */
  | 'caldav'
  /** a CardDAV server (address books) */
  | 'carddav'
  /** a read-only calendar subscription: an http(s)/webcal .ics URL */
  | 'ics'

export interface PimSource {
  id: string
  kind: SourceKind
  name: string
  /** server / subscription URL; absent for 'local' */
  url?: string
  user?: string
  hasPassword: boolean
  /** ISO time of the last successful sync */
  lastSync?: string
  /** the last sync's failure, shown next to the source */
  error?: string
}

export interface PimSourceInput {
  id?: string
  kind: SourceKind
  name: string
  url?: string
  user?: string
  /** empty keeps the stored password when editing */
  password?: string
  /** borrow user name and password from this mail account */
  mailAccountId?: string
}

export interface DavGuess {
  caldav?: string
  carddav?: string
  /** e.g. "Google needs the private iCal address; CalDAV requires OAuth" */
  note?: string
}

// ---- calendars ----

export interface CalendarInfo {
  /** stable across syncs: `${sourceId}:${collection}` */
  id: string
  sourceId: string
  name: string
  /** CSS color, e.g. "#0f6cbd" */
  color: string
  visible: boolean
  readOnly: boolean
}

export type AttendeeStatus = 'needs-action' | 'accepted' | 'declined' | 'tentative'

export interface Attendee {
  name?: string
  email: string
  status: AttendeeStatus
  /** REQ-PARTICIPANT (default) or OPT-PARTICIPANT */
  optional?: boolean
}

export interface Organizer {
  name?: string
  email: string
}

/** one occurrence as the calendar views draw it */
export interface CalendarEvent {
  /** unique per occurrence: `${calendarId}|${uid}|${occurrenceStart}` */
  id: string
  uid: string
  calendarId: string
  title: string
  location: string
  description: string
  start: string
  end: string
  allDay: boolean
  /** set on every occurrence of a recurring series */
  recurring: boolean
  /** the series rule (RRULE value, e.g. "FREQ=WEEKLY;BYDAY=MO"), for editing */
  rrule?: string
  /** the start of this occurrence as the series defines it (RECURRENCE-ID) */
  occurrenceStart?: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  organizer?: Organizer
  attendees: Attendee[]
  /** minutes before start, e.g. [15] */
  reminders: number[]
  /** the IANA zone the event was written in, when it named one */
  timezone?: string
  url?: string
  readOnly: boolean
}

export interface EventInput {
  calendarId: string
  /** absent when creating */
  uid?: string
  title: string
  location?: string
  description?: string
  start: string
  end: string
  allDay: boolean
  /** RRULE value, or null to make the event non-recurring */
  rrule?: string | null
  reminders?: number[]
  attendees?: Attendee[]
  /** editing a recurring event: change only this occurrence, or the whole series */
  scope?: 'occurrence' | 'series'
  /** with scope 'occurrence': which one */
  occurrenceStart?: string
  /** mail the attendees an invitation (iTIP REQUEST) from this mail account */
  inviteFromAccountId?: string
  /** the user's time zone for writing the event (IANA); defaults to the system zone */
  timezone?: string
}

export interface EventRange {
  /** ISO instants; events overlapping [from, to) are returned, recurrences expanded */
  from: string
  to: string
  calendarIds?: string[]
}

// ---- contacts ----

export interface AddressBookInfo {
  id: string
  sourceId: string
  name: string
  readOnly: boolean
}

export interface LabeledValue {
  /** "home", "work", "cell" …, lower case; empty when unknown */
  type: string
  value: string
}

export interface Contact {
  /** `${addressBookId}|${uid}` */
  id: string
  uid: string
  addressBookId: string
  /** FN — the display name */
  name: string
  firstName: string
  lastName: string
  emails: LabeledValue[]
  phones: LabeledValue[]
  organization: string
  jobTitle: string
  /** "YYYY-MM-DD" or "--MM-DD" (year unknown) */
  birthday: string
  /** one formatted postal address per line group */
  addresses: LabeledValue[]
  note: string
  /** data: URL */
  photo?: string
  readOnly: boolean
}

export interface ContactInput {
  addressBookId: string
  uid?: string
  name: string
  firstName?: string
  lastName?: string
  emails?: LabeledValue[]
  phones?: LabeledValue[]
  organization?: string
  jobTitle?: string
  birthday?: string
  addresses?: LabeledValue[]
  note?: string
  photo?: string
}

export interface AddressSuggestion {
  name: string
  email: string
  /** a saved contact, or someone the user wrote to */
  kind: 'contact' | 'recent'
}

// ---- invitations (text/calendar parts in mail) ----

export type ItipMethod = 'REQUEST' | 'CANCEL' | 'REPLY' | 'PUBLISH' | 'COUNTER' | 'REFRESH'

export interface Invitation {
  method: ItipMethod
  uid: string
  sequence: number
  title: string
  location: string
  description: string
  start: string
  end: string
  allDay: boolean
  rrule?: string
  organizer?: Organizer
  attendees: Attendee[]
  /** for REPLY: the answer the sender gave */
  replyStatus?: AttendeeStatus
  /** the whole iCalendar text, as received */
  ics: string
  /** set when the meeting (same UID) is already in one of the user's calendars:
   * the id of that calendar */
  existingEventId?: string
}

export interface InvitationResponse {
  accountId: string
  folder: string
  uid: number
  answer: 'accepted' | 'tentative' | 'declined'
  /** where to put the event; ignored when declining */
  calendarId?: string
  /** also mail the organizer (iTIP REPLY); true by default */
  notifyOrganizer?: boolean
  /** UI language, for the wording of the reply mail */
  lang?: string
}

export interface PimChange {
  kind: 'calendar' | 'contacts' | 'sources'
}

export interface PimApi {
  listSources(): Promise<PimSource[]>
  saveSource(input: PimSourceInput): Promise<MailResult<PimSource>>
  removeSource(id: string): Promise<void>
  testSource(input: PimSourceInput): Promise<MailResult>
  guessDav(email: string): Promise<DavGuess>
  /** sync every remote source (or one) now */
  sync(sourceId?: string): Promise<MailResult>

  listCalendars(): Promise<CalendarInfo[]>
  updateCalendar(
    id: string,
    patch: { color?: string; visible?: boolean; name?: string },
  ): Promise<MailResult>
  createCalendar(sourceId: string, name: string, color: string): Promise<MailResult<CalendarInfo>>
  listEvents(range: EventRange): Promise<MailResult<CalendarEvent[]>>
  getEvent(
    calendarId: string,
    uid: string,
    occurrenceStart?: string,
  ): Promise<MailResult<CalendarEvent>>
  saveEvent(input: EventInput): Promise<MailResult<CalendarEvent>>
  deleteEvent(
    calendarId: string,
    uid: string,
    scope?: 'occurrence' | 'series',
    occurrenceStart?: string,
  ): Promise<MailResult>
  /** pick an .ics file and add its events to the calendar */
  importIcs(calendarId: string): Promise<MailResult<number>>
  /** save a calendar as an .ics file; returns the path */
  exportIcs(calendarId: string): Promise<MailResult<string>>

  listAddressBooks(): Promise<AddressBookInfo[]>
  listContacts(query?: string): Promise<MailResult<Contact[]>>
  saveContact(input: ContactInput): Promise<MailResult<Contact>>
  deleteContact(addressBookId: string, uid: string): Promise<MailResult>
  importVcf(addressBookId: string): Promise<MailResult<number>>
  exportVcf(addressBookId: string): Promise<MailResult<string>>
  suggestAddresses(query: string, limit?: number): Promise<AddressSuggestion[]>
  rememberRecipients(addresses: Array<{ name: string; email: string }>): Promise<void>

  respondInvitation(response: InvitationResponse): Promise<MailResult>

  onChanged(handler: (change: PimChange) => void): () => void
}
