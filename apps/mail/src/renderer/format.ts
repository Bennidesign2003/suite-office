import type { MailAddress, MailMessage } from '../shared/ipc'

/** pure helpers for addresses, dates and reply/forward drafts (unit-tested) */

export function displayName(a: MailAddress): string {
  return a.name?.trim() || a.address
}

export function formatAddress(a: MailAddress): string {
  if (!a.name?.trim() || a.name === a.address) return a.address
  const name = /[",;<>@]/.test(a.name) ? `"${a.name.replace(/"/g, '')}"` : a.name
  return `${name} <${a.address}>`
}

export function formatAddressList(list: MailAddress[]): string {
  return list.map(formatAddress).join(', ')
}

export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** "Re: Re: AW: Hallo" → "Re: Hallo" */
export function replySubject(subject: string): string {
  const bare = subject.replace(/^\s*((re|aw|sv|antw|wg|fw|fwd)\s*(\[\d+\])?\s*:\s*)+/i, '')
  return `Re: ${bare}`
}

export function forwardSubject(subject: string): string {
  const bare = subject.replace(/^\s*((fw|fwd|wg)\s*:\s*)+/i, '')
  return `Fwd: ${bare}`
}

/** readable plain text of an HTML mail, for quoting and for the AI */
export function htmlToText(html: string): string {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of Array.from(doc.querySelectorAll('script, style, head, title'))) el.remove()
  for (const br of Array.from(doc.querySelectorAll('br'))) br.replaceWith('\n')
  for (const block of Array.from(
    doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote'),
  )) {
    block.append('\n')
  }
  return (doc.body?.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function messageText(msg: Pick<MailMessage, 'text' | 'html'>): string {
  const text = msg.text?.trim()
  return text ? text : htmlToText(msg.html)
}

export function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.startsWith('>') ? `>${line}` : `> ${line}`))
    .join('\n')
}

export interface Draft {
  to: string
  cc: string
  bcc: string
  subject: string
  /** what the user writes */
  text: string
  /** the quoted original (reply) or forwarded message, appended on send */
  quoted: string
  inReplyTo?: string
  references?: string[]
  answering?: { folder: string; uid: number }
  attachments: string[]
}

export function emptyDraft(): Draft {
  return { to: '', cc: '', bcc: '', subject: '', text: '', quoted: '', attachments: [] }
}

export function replyDraft(
  msg: MailMessage,
  mode: 'reply' | 'replyAll',
  myAddress: string,
  header: string,
): Draft {
  const target = msg.replyTo.length ? msg.replyTo : msg.from
  let cc: MailAddress[] = []
  if (mode === 'replyAll') {
    const seen = new Set(target.map((a) => a.address.toLowerCase()))
    seen.add(myAddress.toLowerCase())
    cc = [...msg.to, ...msg.cc].filter((a) => {
      const key = a.address.toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  return {
    to: formatAddressList(target),
    cc: formatAddressList(cc),
    bcc: '',
    subject: replySubject(msg.subject),
    text: '',
    quoted: `${header}\n${quote(messageText(msg))}`,
    inReplyTo: msg.messageId,
    references: [...msg.references, ...(msg.messageId ? [msg.messageId] : [])],
    answering: { folder: msg.folder, uid: msg.uid },
    attachments: [],
  }
}

export function forwardDraft(
  msg: MailMessage,
  header: string,
  labels: Record<'from' | 'to' | 'date' | 'subject', string>,
  locale?: string,
): Draft {
  const lines = [
    header,
    `${labels.from}: ${formatAddressList(msg.from)}`,
    `${labels.date}: ${new Date(msg.date).toLocaleString(locale)}`,
    `${labels.subject}: ${msg.subject}`,
    `${labels.to}: ${formatAddressList(msg.to)}`,
    '',
    messageText(msg),
  ]
  return {
    ...emptyDraft(),
    subject: forwardSubject(msg.subject),
    quoted: lines.join('\n'),
  }
}

export function listDate(
  iso: string,
  labels: { today: string; yesterday: string },
  locale?: string,
  now = new Date(),
): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  if (diff === 1) return labels.yesterday
  if (diff < 7 && diff > 0) return d.toLocaleDateString(locale, { weekday: 'short' })
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
  }
  return d.toLocaleDateString(locale)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** the HTML shown in the reading frame: no scripts (sandbox), no network
 * unless the user allowed remote images, links open outside. The mail is
 * document content: it keeps its own light colors in both UI themes. */
export function readerDocument(html: string, text: string, allowRemote: boolean): string {
  const img = allowRemote ? 'data: https: http:' : 'data:'
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:; media-src data:`
  const base = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">`
  if (html) {
    const style = `<style>html{color-scheme:light}body{margin:16px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;word-wrap:break-word}img{max-width:100%;height:auto}</style>`
    return `<!doctype html><html><head>${base}${style}</head><body>${html}</body></html>`
  }
  const escaped = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
  const linked = escaped.replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`)
  const style = `<style>html{color-scheme:light}body{margin:16px;background:#ffffff;color:#1f2328;font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:pre-wrap;word-wrap:break-word}a{color:inherit}</style>`
  return `<!doctype html><html><head>${base}${style}</head><body>${linked}</body></html>`
}

/** the body that goes out: the user's text above the quoted original */
export function outgoingText(draft: Pick<Draft, 'text' | 'quoted'>): string {
  const own = draft.text.replace(/\s+$/, '')
  if (!draft.quoted) return own
  return `${own}\n\n${draft.quoted}`
}

/** "Anna Schmidt <anna@firma.de>", "\"Doe, John\" <j@x.de>" or a bare address → name and email */
export function parseRecipient(value: string): { name: string; email: string } | null {
  const trimmed = value.trim()
  const angled = /^(.*?)<([^<>\s]+@[^<>\s]+)>\s*$/.exec(trimmed)
  if (angled) {
    const name = angled[1]!
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim()
    return { name, email: angled[2]! }
  }
  return /^[^\s@<>]+@[^\s@<>]+$/.test(trimmed) ? { name: '', email: trimmed } : null
}
