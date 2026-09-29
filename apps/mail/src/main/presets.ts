import type { ServerSettings } from '../shared/ipc'

/**
 * IMAP/SMTP servers of the common mailbox providers, so adding an account
 * usually takes just the address and a password. Providers that require
 * OAuth for their own apps accept an app password over IMAP; the note tells
 * the user where to create one.
 */

interface Preset {
  domains: string[]
  imap: ServerSettings
  smtp: ServerSettings
  note?: string
}

const PRESETS: Preset[] = [
  {
    domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    note: 'Google verlangt ein App-Passwort (Google-Konto → Sicherheit → App-Passwörter).',
  },
  {
    domains: ['outlook.com', 'hotmail.com', 'hotmail.de', 'live.com', 'live.de', 'msn.com'],
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    note: 'Microsoft-Konten brauchen ein App-Passwort (account.microsoft.com → Sicherheit).',
  },
  {
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    note: 'Apple verlangt ein app-spezifisches Passwort (account.apple.com → Anmeldung und Sicherheit).',
  },
  {
    domains: ['gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch'],
    imap: { host: 'imap.gmx.net', port: 993, secure: true },
    smtp: { host: 'mail.gmx.net', port: 465, secure: true },
    note: 'IMAP muss in den GMX-Einstellungen unter „POP3/IMAP Abruf“ aktiviert sein.',
  },
  {
    domains: ['web.de'],
    imap: { host: 'imap.web.de', port: 993, secure: true },
    smtp: { host: 'smtp.web.de', port: 587, secure: false },
    note: 'IMAP muss in den WEB.DE-Einstellungen unter „POP3/IMAP Abruf“ aktiviert sein.',
  },
  {
    domains: ['t-online.de', 'magenta.de'],
    imap: { host: 'secureimap.t-online.de', port: 993, secure: true },
    smtp: { host: 'securesmtp.t-online.de', port: 465, secure: true },
    note: 'Telekom verlangt ein eigenes E-Mail-Passwort (Kundencenter → E-Mail-Passwort).',
  },
  {
    domains: ['yahoo.com', 'yahoo.de'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    note: 'Yahoo verlangt ein App-Passwort (Kontosicherheit → App-Passwort generieren).',
  },
  {
    domains: ['posteo.de', 'posteo.net'],
    imap: { host: 'posteo.de', port: 993, secure: true },
    smtp: { host: 'posteo.de', port: 465, secure: true },
  },
  {
    domains: ['mailbox.org'],
    imap: { host: 'imap.mailbox.org', port: 993, secure: true },
    smtp: { host: 'smtp.mailbox.org', port: 465, secure: true },
  },
  {
    domains: ['proton.me', 'protonmail.com', 'pm.me'],
    imap: { host: '127.0.0.1', port: 1143, secure: false },
    smtp: { host: '127.0.0.1', port: 1025, secure: false },
    note: 'Proton funktioniert nur über die Proton Mail Bridge; Zugangsdaten stehen in der Bridge.',
  },
]

export function guessServers(
  email: string,
): { imap: ServerSettings; smtp: ServerSettings; note?: string } | null {
  const domain = email.split('@')[1]?.trim().toLowerCase()
  if (!domain) return null
  const preset = PRESETS.find((p) => p.domains.includes(domain))
  if (preset) return { imap: { ...preset.imap }, smtp: { ...preset.smtp }, note: preset.note }
  // the common convention; the user can correct it in the form
  return {
    imap: { host: `imap.${domain}`, port: 993, secure: true },
    smtp: { host: `smtp.${domain}`, port: 465, secure: true },
  }
}
