import type { Translate } from '../calendar/types'

/**
 * Contacts UI strings (address book, contact editor, recipient suggestions).
 * German and English are complete; every other UI language falls back to
 * English until it is translated (`de` defines the key set).
 */

const de = {
  title: 'Kontakte',
  newContact: 'Neuer Kontakt',
  importVcf: 'Importieren',
  importInto: 'Kontakte aus einer vCard-Datei (.vcf) in „{book}“ importieren',
  exportVcf: 'Exportieren',
  exportFrom: '„{book}“ als vCard-Datei (.vcf) speichern',
  refresh: 'Aktualisieren',
  syncing: 'Wird aktualisiert …',
  synced: 'Adressbücher aktualisiert.',
  chooseBook: 'Adressbuch wählen',
  noWritableBook: 'Es gibt kein beschreibbares Adressbuch.',
  imported: '{count} Kontakte importiert.',
  importedOne: '1 Kontakt importiert.',
  exported: 'Gespeichert unter {path}',
  searchPlaceholder: 'Kontakte durchsuchen',
  allContacts: 'Alle Kontakte',
  addressBooks: 'Adressbücher',
  addBook: 'Adressbuch hinzufügen',
  editSource: 'Konto bearbeiten',
  removeSource: 'Konto entfernen',
  removeSourceConfirm:
    'Adressbuch-Konto „{name}“ aus Suite Office entfernen? Die Kontakte bleiben auf dem Server.',
  otherBooks: 'Weitere Adressbücher',
  syncFailed: 'Synchronisierung fehlgeschlagen',
  lastSync: 'Zuletzt synchronisiert: {time}',
  readOnly: 'Schreibgeschützt',
  count: '{count} Kontakte',
  countOne: '1 Kontakt',
  loading: 'Wird geladen …',
  noContacts: 'Noch keine Kontakte in diesem Adressbuch.',
  noResults: 'Keine Kontakte gefunden.',
  noSelection: 'Wähle einen Kontakt aus, um die Details zu sehen.',
  emptyTitle: 'Deine Kontakte',
  emptyBody:
    'Lege Kontakte an, importiere eine vCard-Datei oder verbinde ein Adressbuch per CardDAV – iCloud, Nextcloud, Posteo, mailbox.org, GMX, WEB.DE und viele mehr.',
  unavailable: 'Kontakte sind in dieser Umgebung nicht verfügbar.',
  noName: '(Ohne Namen)',
  edit: 'Bearbeiten',
  delete: 'Löschen',
  deleteConfirm: 'Kontakt „{name}“ löschen?',
  writeMail: 'E-Mail an {email} schreiben',
  call: '{phone} anrufen',
  copy: 'Kopieren',
  copied: 'In die Zwischenablage kopiert.',
  errorPrefix: 'Fehler',
  // fields
  email: 'E-Mail',
  phone: 'Telefon',
  address: 'Adresse',
  birthday: 'Geburtstag',
  note: 'Notiz',
  organization: 'Firma',
  jobTitle: 'Position',
  addressBook: 'Adressbuch',
  typeHome: 'Privat',
  typeWork: 'Arbeit',
  typeCell: 'Mobil',
  typeOther: 'Sonstige',
  typeFax: 'Fax',
  typePager: 'Pager',
  typeMain: 'Zentrale',
  // editor
  editorNew: 'Neuer Kontakt',
  editorEdit: 'Kontakt bearbeiten',
  firstName: 'Vorname',
  lastName: 'Nachname',
  displayName: 'Anzeigename',
  addEmail: 'E-Mail-Adresse hinzufügen',
  addPhone: 'Telefonnummer hinzufügen',
  addAddress: 'Adresse hinzufügen',
  removeRow: 'Entfernen',
  typeLabel: 'Art',
  addressPlaceholder: 'Straße und Hausnummer\nPLZ Ort\nLand',
  photo: 'Foto',
  photoChoose: 'Foto auswählen …',
  photoChange: 'Foto ändern …',
  photoRemove: 'Foto entfernen',
  photoError: 'Das Bild konnte nicht gelesen werden.',
  photoTooLarge: 'Das Bild ist zu groß (höchstens 25 MB).',
  birthdayNoYear: 'Gespeichert ohne Jahr: {date}',
  birthdayStored: 'Gespeichert als „{date}“',
  save: 'Speichern',
  saving: 'Wird gespeichert …',
  cancel: 'Abbrechen',
  needNameOrEmail: 'Bitte gib mindestens einen Namen oder eine E-Mail-Adresse an.',
  invalidEmail: '„{email}“ ist keine gültige E-Mail-Adresse.',
  discardConfirm: 'Änderungen an diesem Kontakt verwerfen?',
  // recipient suggestions
  suggestions: 'Vorschläge',
  suggestContact: 'Kontakt',
  suggestRecent: 'Zuletzt',
} as const

export type ContactsStringKey = keyof typeof de

const en: Record<ContactsStringKey, string> = {
  title: 'Contacts',
  newContact: 'New contact',
  importVcf: 'Import',
  importInto: 'Import contacts from a vCard file (.vcf) into “{book}”',
  exportVcf: 'Export',
  exportFrom: 'Save “{book}” as a vCard file (.vcf)',
  refresh: 'Refresh',
  syncing: 'Refreshing…',
  synced: 'Address books refreshed.',
  chooseBook: 'Choose an address book',
  noWritableBook: 'There is no address book you can write to.',
  imported: '{count} contacts imported.',
  importedOne: '1 contact imported.',
  exported: 'Saved to {path}',
  searchPlaceholder: 'Search contacts',
  allContacts: 'All contacts',
  addressBooks: 'Address books',
  addBook: 'Add address book',
  editSource: 'Edit account',
  removeSource: 'Remove account',
  removeSourceConfirm:
    'Remove the address book account “{name}” from Suite Office? The contacts stay on the server.',
  otherBooks: 'Other address books',
  syncFailed: 'Sync failed',
  lastSync: 'Last synced: {time}',
  readOnly: 'Read-only',
  count: '{count} contacts',
  countOne: '1 contact',
  loading: 'Loading…',
  noContacts: 'No contacts in this address book yet.',
  noResults: 'No contacts found.',
  noSelection: 'Select a contact to see the details.',
  emptyTitle: 'Your contacts',
  emptyBody:
    'Create contacts, import a vCard file or connect an address book over CardDAV — iCloud, Nextcloud, Fastmail, Posteo, mailbox.org, GMX and many more.',
  unavailable: 'Contacts are not available here.',
  noName: '(No name)',
  edit: 'Edit',
  delete: 'Delete',
  deleteConfirm: 'Delete the contact “{name}”?',
  writeMail: 'Write an email to {email}',
  call: 'Call {phone}',
  copy: 'Copy',
  copied: 'Copied to the clipboard.',
  errorPrefix: 'Error',
  email: 'Email',
  phone: 'Phone',
  address: 'Address',
  birthday: 'Birthday',
  note: 'Note',
  organization: 'Company',
  jobTitle: 'Job title',
  addressBook: 'Address book',
  typeHome: 'Home',
  typeWork: 'Work',
  typeCell: 'Mobile',
  typeOther: 'Other',
  typeFax: 'Fax',
  typePager: 'Pager',
  typeMain: 'Main',
  editorNew: 'New contact',
  editorEdit: 'Edit contact',
  firstName: 'First name',
  lastName: 'Last name',
  displayName: 'Display name',
  addEmail: 'Add email address',
  addPhone: 'Add phone number',
  addAddress: 'Add address',
  removeRow: 'Remove',
  typeLabel: 'Type',
  addressPlaceholder: 'Street\nPostcode City\nCountry',
  photo: 'Photo',
  photoChoose: 'Choose photo…',
  photoChange: 'Change photo…',
  photoRemove: 'Remove photo',
  photoError: 'The picture could not be read.',
  photoTooLarge: 'The picture is too large (25 MB at most).',
  birthdayNoYear: 'Saved without a year: {date}',
  birthdayStored: 'Saved as “{date}”',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  needNameOrEmail: 'Please enter at least a name or an email address.',
  invalidEmail: '“{email}” is not a valid email address.',
  discardConfirm: 'Discard your changes to this contact?',
  suggestions: 'Suggestions',
  suggestContact: 'Contact',
  suggestRecent: 'Recent',
}

const tables: Record<string, Record<ContactsStringKey, string>> = { de, en }

export function contactsTranslator(lang: string): Translate<ContactsStringKey> {
  const table = tables[(lang || '').slice(0, 2)] ?? en
  return (key, vars) => {
    let text = table[key] ?? en[key]
    if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(v)
    return text
  }
}

const TYPE_KEYS: Record<string, ContactsStringKey> = {
  home: 'typeHome',
  work: 'typeWork',
  cell: 'typeCell',
  mobile: 'typeCell',
  iphone: 'typeCell',
  other: 'typeOther',
  fax: 'typeFax',
  pager: 'typePager',
  main: 'typeMain',
  voice: 'phone',
  internet: 'email',
}

/**
 * The label for a vCard TYPE ("home", "work", "cell" …). Servers also send
 * lists like "work,voice" or vendor types; the first one we know wins, and
 * an unknown type is shown as written rather than hidden.
 */
export function typeName(t: Translate<ContactsStringKey>, type: string): string {
  const parts = (type || '')
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter((p) => p && p !== 'pref')
  for (const part of parts) {
    const key = TYPE_KEYS[part]
    if (key) return t(key)
  }
  const first = parts[0] ?? ''
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : ''
}

// Apple writes birthdays without a year as 1604-MM-DD (X-APPLE-OMIT-YEAR)
const NO_YEAR = 1604

/**
 * "1985-04-12" → "12. April 1985" (per language); "--04-12" → "12. April".
 * Anything unexpected is shown as stored instead of guessing.
 */
export function formatBirthday(value: string, lang: string): string {
  const text = (value || '').trim()
  const full = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/.exec(text)
  const partial = /^--(\d{2})-?(\d{2})$/.exec(text)
  const parts = full
    ? { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]) }
    : partial
      ? { year: NO_YEAR, month: Number(partial[1]), day: Number(partial[2]) }
      : null
  if (!parts) return text
  // a leap year stands in for an unknown one, so 29 February survives
  const date = new Date(0)
  date.setUTCFullYear(parts.year === NO_YEAR ? 2000 : parts.year, parts.month - 1, parts.day)
  if (date.getUTCMonth() !== parts.month - 1 || date.getUTCDate() !== parts.day) return text
  try {
    return date.toLocaleDateString(lang || undefined, {
      day: 'numeric',
      month: 'long',
      ...(parts.year === NO_YEAR ? {} : { year: 'numeric' }),
      timeZone: 'UTC',
    })
  } catch {
    // an odd language tag must not take the contact card down
    return text
  }
}
