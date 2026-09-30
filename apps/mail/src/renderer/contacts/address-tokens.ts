/**
 * Pure helpers for recipient fields ("To", "Cc", attendees): splitting a
 * typed line into recipients, finding the one under the caret for
 * autocomplete, and writing a picked address back. A comma inside a quoted
 * display name ("Doe, John" <j@x.de>) or inside <…> never separates
 * recipients, so names in "Last, First" form survive a round trip.
 */

export interface RecipientToken {
  /** index of the first character after the preceding separator */
  start: number
  /** index of the next separator, or the end of the value */
  end: number
  /** the recipient under the caret, trimmed */
  text: string
}

/** positions of the commas / semicolons that separate recipients */
function separators(value: string): number[] {
  const found: number[] = []
  let quoted = false
  let angle = 0
  let comment = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (quoted) {
      if (ch === '\\') i++
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === '<') angle++
    else if (ch === '>') angle = Math.max(0, angle - 1)
    else if (ch === '(') comment++
    else if (ch === ')') comment = Math.max(0, comment - 1)
    else if ((ch === ',' || ch === ';') && angle === 0 && comment === 0) found.push(i)
  }
  return found
}

/** "a@x.de, "Doe, John" <j@x.de>; b@y.de" → three recipients, trimmed, empties dropped */
export function splitRecipients(value: string): string[] {
  if (!value) return []
  const parts: string[] = []
  let from = 0
  for (const at of [...separators(value), value.length]) {
    const part = value.slice(from, at).trim()
    if (part) parts.push(part)
    from = at + 1
  }
  return parts
}

/** the recipient the caret is in — what autocomplete should complete */
export function currentToken(value: string, caret: number): RecipientToken {
  const pos = Math.max(0, Math.min(Number.isFinite(caret) ? caret : value.length, value.length))
  let start = 0
  let end = value.length
  for (const at of separators(value)) {
    if (at < pos) start = at + 1
    else {
      end = at
      break
    }
  }
  return { start, end, text: value.slice(start, end).trim() }
}

/**
 * Puts `replacement` where `token` was. At the end of the field a separator
 * follows, so the user can type the next recipient right away:
 * "a@x.de, jo" → "a@x.de, John Doe <john@x.de>, ".
 */
export function replaceToken(value: string, token: RecipientToken, replacement: string): string {
  const before = value.slice(0, Math.max(0, token.start)).replace(/\s+$/, '')
  const after = value.slice(Math.min(value.length, token.end))
  const lead = before ? `${before} ` : ''
  return after ? `${lead}${replacement}${after}` : `${lead}${replacement}, `
}

// RFC 5322 "specials": a display name containing one of them must be quoted
const SPECIALS = /[()<>[\]:;@\\,."]/

/** "Doe, John" + "j@x.de" → "\"Doe, John\" <j@x.de>"; no name → the bare address */
export function formatRecipient(name: string, email: string): string {
  // a line break would let a name smuggle extra header lines into the mail
  const address = email.replace(/[\s<>]+/g, '')
  const display = name.replace(/[\r\n\t]+/g, ' ').trim()
  if (!display || display.toLowerCase() === address.toLowerCase()) return address
  if (!address) return display
  // quotes inside a quoted name would need escaping that not every parser
  // undoes; dropping them is what the mail list's formatAddress does too
  const clean = SPECIALS.test(display) ? display.replace(/["\\]/g, '').trim() : display
  if (!clean) return address
  return SPECIALS.test(clean) ? `"${clean}" <${address}>` : `${clean} <${address}>`
}

/**
 * A plausibility check, not RFC validation: one @, no spaces or address
 * punctuation, a dotted domain with a real-looking top-level part. Umlaut
 * domains (IDN) pass.
 */
export function isLikelyEmail(value: string): boolean {
  const match = /^([^\s@<>()[\]\\,;:"]+)@([^\s@<>()[\]\\,;:"]+)$/.exec(value.trim())
  if (!match) return false
  const local = match[1]!
  const domain = match[2]!
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false
  const labels = domain.split('.')
  if (labels.length < 2) return false
  if (labels.some((l) => !l || l.startsWith('-') || l.endsWith('-'))) return false
  const tld = labels[labels.length - 1]!
  return tld.length >= 2 && !/^\d+$/.test(tld)
}
