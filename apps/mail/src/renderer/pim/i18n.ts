import type { Translate } from '../calendar/types'

/**
 * Strings shared by the calendar and contacts modules (the "add source"
 * dialog). German and English are complete; other UI languages fall back to
 * English until translated (`de` defines the key set).
 */

const de = {
  addCalendarSource: 'Kalender hinzufügen',
  addAddressBookSource: 'Adressbuch hinzufügen',
  addSource: 'Verbindung hinzufügen',
  editSource: 'Verbindung bearbeiten',
  kind: 'Art',
  kindCaldav: 'CalDAV-Konto',
  kindCarddav: 'CardDAV-Konto',
  kindIcs: 'Kalender-Abo (ICS)',
  kindLocal: 'Auf diesem Computer',
  hintCaldav:
    'Kalender lesen und bearbeiten – iCloud, Nextcloud, Posteo, mailbox.org, GMX/WEB.DE, Fastmail und andere.',
  hintCarddav:
    'Adressbücher lesen und bearbeiten – iCloud, Nextcloud, Posteo, mailbox.org, GMX/WEB.DE, Fastmail und andere.',
  hintIcs: 'Nur lesen, z. B. Googles „Privatadresse im iCal-Format“ oder ein Feiertagskalender.',
  hintLocal: 'Wird nur auf diesem Computer gespeichert.',
  name: 'Name',
  namePlaceholder: 'z. B. Privat oder Arbeit',
  serverUrl: 'Server-Adresse',
  serverUrlPlaceholder: 'https://…',
  icsUrl: 'Abo-Adresse',
  icsUrlPlaceholder: 'https://… oder webcal://…',
  credentials: 'Anmeldung',
  useMailLogin: 'Anmeldung des E-Mail-Kontos verwenden',
  mailAccount: 'E-Mail-Konto',
  ownLogin: 'Eigener Benutzername und Passwort',
  icsNeedsLogin: 'Das Abo ist passwortgeschützt',
  user: 'Benutzername',
  password: 'Passwort',
  passwordKeep: 'Leer lassen, um das gespeicherte Passwort zu behalten',
  appPasswordHint:
    'Mit Zwei-Faktor-Anmeldung verlangen die meisten Anbieter ein eigenes App-Passwort.',
  test: 'Verbindung testen',
  testing: 'Wird getestet …',
  testOk: 'Verbindung erfolgreich.',
  saving: 'Wird verbunden und synchronisiert …',
  save: 'Speichern',
  cancel: 'Abbrechen',
  urlMissing: 'Bitte die Adresse angeben.',
  privacy:
    'Zugangsdaten werden nur auf diesem Rechner gespeichert; die Daten fließen direkt zwischen diesem Rechner und deinem Anbieter.',
} as const

export type PimStringKey = keyof typeof de

const en: Record<PimStringKey, string> = {
  addCalendarSource: 'Add calendar',
  addAddressBookSource: 'Add address book',
  addSource: 'Add connection',
  editSource: 'Edit connection',
  kind: 'Type',
  kindCaldav: 'CalDAV account',
  kindCarddav: 'CardDAV account',
  kindIcs: 'Calendar subscription (ICS)',
  kindLocal: 'On this computer',
  hintCaldav:
    'Read and edit calendars — iCloud, Nextcloud, Posteo, mailbox.org, GMX/WEB.DE, Fastmail and others.',
  hintCarddav:
    'Read and edit address books — iCloud, Nextcloud, Posteo, mailbox.org, GMX/WEB.DE, Fastmail and others.',
  hintIcs: 'Read-only, e.g. Google’s “Secret address in iCal format” or a holiday calendar.',
  hintLocal: 'Stored on this computer only.',
  name: 'Name',
  namePlaceholder: 'e.g. Personal or Work',
  serverUrl: 'Server address',
  serverUrlPlaceholder: 'https://…',
  icsUrl: 'Subscription address',
  icsUrlPlaceholder: 'https://… or webcal://…',
  credentials: 'Sign-in',
  useMailLogin: 'Use the sign-in of the mail account',
  mailAccount: 'Mail account',
  ownLogin: 'Separate user name and password',
  icsNeedsLogin: 'The subscription is password-protected',
  user: 'User name',
  password: 'Password',
  passwordKeep: 'Leave empty to keep the stored password',
  appPasswordHint: 'With two-factor sign-in most providers require a separate app password.',
  test: 'Test connection',
  testing: 'Testing…',
  testOk: 'Connection works.',
  saving: 'Connecting and syncing…',
  save: 'Save',
  cancel: 'Cancel',
  urlMissing: 'Please enter the address.',
  privacy:
    'Credentials are stored on this computer only; your data travels directly between this computer and your provider.',
}

const tables: Record<string, Record<PimStringKey, string>> = { de, en }

export type PimT = Translate<PimStringKey>

export function pimTranslator(lang: string): PimT {
  const table = tables[lang.slice(0, 2).toLowerCase()] ?? en
  return (key, vars) => {
    let text = table[key] ?? en[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(v)
    return text
  }
}
