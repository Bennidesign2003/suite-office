import type { DavGuess } from '../../shared/pim'

/**
 * Where the common mailbox providers serve calendars and address books, so
 * connecting them usually needs no URL typed by hand. Providers without
 * CalDAV for app passwords get a note pointing at their read-only .ics link.
 */

interface DavPreset {
  domains: string[]
  caldav?: string
  carddav?: string
  note?: string
}

const PRESETS: DavPreset[] = [
  {
    domains: ['icloud.com', 'me.com', 'mac.com'],
    caldav: 'https://caldav.icloud.com',
    carddav: 'https://contacts.icloud.com',
    note: 'Apple verlangt ein app-spezifisches Passwort (account.apple.com → Anmeldung und Sicherheit).',
  },
  {
    domains: ['gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch'],
    caldav: 'https://caldav.gmx.net',
    carddav: 'https://carddav.gmx.net',
  },
  {
    domains: ['web.de'],
    caldav: 'https://caldav.web.de',
    carddav: 'https://carddav.web.de',
  },
  {
    domains: ['posteo.de', 'posteo.net'],
    caldav: 'https://posteo.de:8443',
    carddav: 'https://posteo.de:8843',
  },
  {
    domains: ['mailbox.org'],
    caldav: 'https://dav.mailbox.org',
    carddav: 'https://dav.mailbox.org',
  },
  {
    domains: ['fastmail.com', 'fastmail.fm'],
    caldav: 'https://caldav.fastmail.com',
    carddav: 'https://carddav.fastmail.com',
    note: 'Fastmail verlangt ein App-Passwort mit CalDAV/CardDAV-Zugriff.',
  },
  {
    domains: ['yahoo.com', 'yahoo.de'],
    caldav: 'https://caldav.calendar.yahoo.com',
    carddav: 'https://carddav.address.yahoo.com',
    note: 'Yahoo verlangt ein App-Passwort.',
  },
  {
    domains: ['t-online.de', 'magenta.de'],
    note: 'Die Telekom bietet keinen CalDAV-Zugang für externe Programme an; ein Kalender-Abo (.ics) funktioniert.',
  },
  {
    domains: ['gmail.com', 'googlemail.com'],
    note:
      'Google erlaubt CalDAV nur mit OAuth. Stattdessen: Google Kalender → Einstellungen → Kalender → ' +
      '„Privatadresse im iCal-Format“ als Kalender-Abo eintragen (nur lesen).',
  },
  {
    domains: ['outlook.com', 'hotmail.com', 'hotmail.de', 'live.com', 'live.de', 'msn.com'],
    note:
      'Outlook.com bietet kein CalDAV. Stattdessen: Outlook im Web → Einstellungen → Kalender → ' +
      '„Freigegebene Kalender“ → Kalender veröffentlichen und den ICS-Link als Abo eintragen (nur lesen).',
  },
]

export function guessDav(email: string): DavGuess {
  const domain = email.split('@')[1]?.trim().toLowerCase()
  if (!domain) return {}
  const preset = PRESETS.find((p) => p.domains.includes(domain))
  if (preset) {
    return {
      ...(preset.caldav ? { caldav: preset.caldav } : {}),
      ...(preset.carddav ? { carddav: preset.carddav } : {}),
      ...(preset.note ? { note: preset.note } : {}),
    }
  }
  // own domains often run Nextcloud or another server that supports the
  // RFC 6764 well-known redirects; tsdav follows them from the bare host
  return {
    caldav: `https://${domain}`,
    carddav: `https://${domain}`,
    note: 'Für Nextcloud lautet die Adresse meist https://<server>/remote.php/dav.',
  }
}
