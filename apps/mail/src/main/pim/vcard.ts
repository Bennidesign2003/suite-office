import type { LabeledValue } from '../../shared/pim'
import {
  escapeText,
  fold,
  parseComponents,
  splitStructured,
  unescapeText,
  type Component,
  type ContentLine,
} from './contentline'

/**
 * vCard 2.1 / 3.0 / 4.0 ↔ the Contact model. Reading is forgiving — Outlook's
 * 2.1 exports with quoted-printable and code pages, Apple's item1.X-ABLabel
 * groups, 4.0 data URIs and year-less birthdays. Writing produces vCard 3.0,
 * the version every CardDAV server and phone accepts, and carries everything
 * the model does not know (X-*, CATEGORIES, URL, IMPP, second titles …) over
 * from the card being rewritten, so editing a contact here never strips what
 * another client stored.
 */

export const VCARD_PRODID = '-//Suite Office//Mail//DE'

/** what the app edits; `serializeVcard` turns it into a card */
export interface CardFields {
  uid: string
  name: string
  firstName?: string
  lastName?: string
  emails?: LabeledValue[]
  phones?: LabeledValue[]
  organization?: string
  jobTitle?: string
  /** "YYYY-MM-DD" or "--MM-DD" */
  birthday?: string
  /** one formatted postal address per entry, lines separated by "\n" */
  addresses?: LabeledValue[]
  note?: string
  /** data: URL */
  photo?: string
}

export interface ParsedCard {
  /** '' when the card has none — the caller decides what identifies it */
  uid: string
  name: string
  firstName: string
  lastName: string
  emails: LabeledValue[]
  phones: LabeledValue[]
  organization: string
  jobTitle: string
  birthday: string
  addresses: LabeledValue[]
  note: string
  photo?: string
  /** KIND (4.0) or X-ADDRESSBOOKSERVER-KIND (Apple), lower case: 'individual', 'group', 'org' … */
  kind: string
  /** VERSION as written, e.g. "3.0"; '' when missing */
  version: string
  /** the parsed card, for rewriting it without losing unknown properties */
  raw: Component
}

// ---- reading ----

interface Item {
  value: LabeledValue
  line: ContentLine
  /** 1 = preferred … 100, 101 = no preference */
  rank: number
  /** ADR only: the seven unescaped components */
  parts?: string[]
}

interface Reading {
  card: ParsedCard
  version: string
  /** modeled lines whose content the fields represent; everything else is carried over */
  consumed: Set<ContentLine>
  fn?: ContentLine
  n?: { line: ContentLine; raw: string[] }
  org?: { line: ContentLine; raw: string[] }
  title?: ContentLine
  bday?: ContentLine
  notes: ContentLine[]
  photo?: ContentLine
  /** 2.1/3.0 formatted address labels; stale once an address changes */
  labels: ContentLine[]
  emails: Item[]
  phones: Item[]
  addresses: Item[]
  /** group (lower case) → its X-ABLabel / X-ABADR lines */
  companions: Map<string, ContentLine[]>
  company: boolean
}

/** Apple's per-group helper lines: they belong to whatever else carries the group */
const COMPANIONS = new Set(['X-ABLABEL', 'X-ABADR'])
/** TYPE values that 2.1 bare parameters smuggle in but that describe the encoding */
const PSEUDO_TYPES = new Set(['quoted-printable', 'base64', '8bit', '7bit', 'b'])

const EMAIL_TYPES = ['home', 'work', 'other']
const TEL_TYPES = [
  'fax',
  'pager',
  'cell',
  'iphone',
  'main',
  'home',
  'work',
  'other',
  'text',
  'video',
  'car',
  'isdn',
  'textphone',
]
const ADR_TYPES = ['home', 'work', 'other']
const IGNORED_TYPES: Record<'EMAIL' | 'TEL' | 'ADR', Set<string>> = {
  EMAIL: new Set(['internet', 'x400', 'pref']),
  TEL: new Set(['voice', 'pref', 'msg']),
  ADR: new Set(['dom', 'intl', 'postal', 'parcel', 'pref']),
}
/** the TYPE values we write back as TYPE (anything else becomes an X-ABLabel) */
const TYPE_PARAMS: Record<'EMAIL' | 'TEL' | 'ADR', Set<string>> = {
  EMAIL: new Set(EMAIL_TYPES),
  TEL: new Set(TEL_TYPES.concat('voice')),
  ADR: new Set(ADR_TYPES),
}
const APPLE_LABELS: Record<string, string> = {
  mobile: 'cell',
  homefax: 'fax',
  workfax: 'fax',
  otherfax: 'fax',
}

const MIME_BY_TYPE: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tiff: 'image/tiff',
  heic: 'image/heic',
}

/** Outlook folds quoted-printable with a trailing "=" instead of a leading space */
function prepare(text: string): string {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    const colon = line.indexOf(':')
    if (colon > 0 && /QUOTED-PRINTABLE/i.test(line.slice(0, colon))) {
      while (
        line.endsWith('=') &&
        i + 1 < lines.length &&
        lines[i + 1] !== '' &&
        !/^(BEGIN|END):/i.test(lines[i + 1]!)
      ) {
        line = line.slice(0, -1) + lines[++i]
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

function decodeBytes(bytes: Uint8Array, charset?: string): string {
  const label = (charset ?? '').trim().toLowerCase()
  if (label && label !== 'utf-8' && label !== 'utf8') {
    try {
      return new TextDecoder(label).decode(bytes)
    } catch {
      // unknown label: guess below
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Outlook without a CHARSET writes the Windows code page
    try {
      return new TextDecoder('windows-1252').decode(bytes)
    } catch {
      return Buffer.from(bytes).toString('latin1')
    }
  }
}

function decodeQuotedPrintable(value: string, charset?: string): string {
  const bytes: number[] = []
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!
    if (c === '=') {
      const hex = value.slice(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
        continue
      }
      if (i === value.length - 1) continue // a soft break the file cut off
    }
    const cp = value.codePointAt(i)!
    if (cp > 0xffff) i++
    for (const b of Buffer.from(String.fromCodePoint(cp), 'utf8')) bytes.push(b)
  }
  return decodeBytes(Uint8Array.from(bytes), charset)
}

function encodingOf(line: ContentLine): 'qp' | 'b64' | '' {
  const values = [...(line.params.ENCODING ?? []), ...(line.params.TYPE ?? [])].map((v) =>
    v.trim().toUpperCase(),
  )
  if (values.includes('QUOTED-PRINTABLE')) return 'qp'
  if ((line.params.ENCODING ?? []).some((v) => /^(b|base64)$/i.test(v.trim()))) return 'b64'
  if (values.includes('BASE64')) return 'b64'
  return ''
}

/** the value with 2.1 transfer encodings undone, still TEXT-escaped */
function decoded(line: ContentLine): string {
  return encodingOf(line) === 'qp'
    ? decodeQuotedPrintable(line.value, line.params.CHARSET?.[0])
    : line.value
}

function text(line: ContentLine | undefined): string {
  // quoted-printable carries Windows line breaks (=0D=0A)
  return line ? unescapeText(decoded(line)).replace(/\r\n?/g, '\n') : ''
}

/** split at unescaped separators, keeping the escapes (for re-writing parts untouched) */
function splitRaw(value: string, separator: string): string[] {
  const out: string[] = []
  let current = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!
    if (c === '\\' && i + 1 < value.length) {
      current += c + value[i + 1]
      i++
    } else if (c === separator) {
      out.push(current)
      current = ''
    } else current += c
  }
  out.push(current)
  return out
}

function typesOf(line: ContentLine): string[] {
  return (line.params.TYPE ?? [])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v && !PSEUDO_TYPES.has(v))
}

function rankOf(line: ContentLine): number {
  const pref = line.params.PREF?.[0]
  if (pref !== undefined) {
    const n = parseInt(pref, 10)
    return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 1
  }
  return typesOf(line).includes('pref') ? 1 : 101
}

function labelType(label: string): string {
  const apple = /^_\$!<(.*)>!\$_$/.exec(label.trim())
  const plain = (apple ? apple[1]! : label).trim().toLowerCase()
  return apple ? (APPLE_LABELS[plain] ?? plain) : plain
}

function typeOf(line: ContentLine, kind: 'EMAIL' | 'TEL' | 'ADR', reading: Reading): string {
  if (line.group) {
    const label = reading.companions
      .get(line.group.toLowerCase())
      ?.find((c) => c.name === 'X-ABLABEL')
    const type = label ? labelType(text(label)) : ''
    if (type) return type
  }
  const types = typesOf(line).map((t) => (t === 'mobile' ? 'cell' : t))
  const known = kind === 'EMAIL' ? EMAIL_TYPES : kind === 'TEL' ? TEL_TYPES : ADR_TYPES
  for (const k of known) if (types.includes(k)) return k
  return types.find((t) => !IGNORED_TYPES[kind].has(t)) ?? ''
}

function validMonthDay(month: string, day: string): boolean {
  const m = Number(month)
  const d = Number(day)
  return m >= 1 && m <= 12 && d >= 1 && d <= 31
}

/**
 * "YYYY-MM-DD" / "--MM-DD" from what cards and people write: 19850412,
 * 1985-04-12T00:00:00Z, --0412, --04-12, 12.04.1985, and Apple's year-less
 * 1604-04-12 with X-APPLE-OMIT-YEAR=1604. '' when it is not a date.
 */
export function normalizeBirthday(value: string, omitYear?: string): string {
  const v = String(value ?? '').trim()
  let m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T\s].*)?$/.exec(v)
  if (m) {
    const [, y, mo, d] = m as unknown as [string, string, string, string]
    if (!validMonthDay(mo, d)) return ''
    return y === '0000' || y === omitYear?.trim() ? `--${mo}-${d}` : `${y}-${mo}-${d}`
  }
  m = /^--(\d{2})-?(\d{2})$/.exec(v)
  if (m && validMonthDay(m[1]!, m[2]!)) return `--${m[1]}-${m[2]}`
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v)
  if (m) {
    const mo = m[2]!.padStart(2, '0')
    const d = m[1]!.padStart(2, '0')
    return validMonthDay(mo, d) ? `${m[3]}-${mo}-${d}` : ''
  }
  return ''
}

function sniffImage(b64: string): string {
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (b64.startsWith('R0lGOD')) return 'image/gif'
  if (b64.startsWith('UklGR')) return 'image/webp'
  if (b64.startsWith('Qk')) return 'image/bmp'
  return 'image/jpeg'
}

/** an embedded picture as a data: URL; remote URLs are left alone (never fetched) */
function photoOf(line: ContentLine): string | undefined {
  const value = line.value.trim()
  if (/^data:/i.test(value)) {
    // some writers TEXT-escape the URI ("base64\,…")
    const m = /^data:(image\/[\w.+-]+)(?:;[^,;]*)*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(
      value.replace(/\\([,;])/g, '$1'),
    )
    return m ? `data:${m[1]!.toLowerCase()};base64,${m[2]!.replace(/\s+/g, '')}` : undefined
  }
  if (encodingOf(line) !== 'b64') return undefined
  const b64 = value.replace(/\s+/g, '')
  if (!b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) return undefined
  const mime =
    typesOf(line)
      .map((t) => (t.includes('/') ? t : MIME_BY_TYPE[t]))
      .find((t): t is string => !!t && t.startsWith('image/')) ?? sniffImage(b64)
  return `data:${mime};base64,${b64}`
}

function lines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * The seven ADR components as the lines people read: street, "code city"
 * (or the US "City, ST 12345"), region, country.
 */
export function formatAddress(parts: string[]): string {
  const [pobox = '', ext = '', street = '', locality = '', region = '', code = '', country = ''] =
    parts.map((p) => (p ?? '').trim())
  const us = /^\d{5}(-\d{4})?$/.test(code) && /^[A-Z]{2}$/.test(region)
  const city = us
    ? `${locality ? `${locality}, ` : ''}${region} ${code}`
    : [code, locality].filter(Boolean).join(' ')
  return [pobox, ext, ...lines(street), city, us ? '' : region, country]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
}

// postcode shapes, the longer ones first: NL "1012 LG", SE "123 45", PL "00-950", PT "1000-001"
const EU_CITY =
  /^(\d{4} ?[A-Z]{2}|\d{3} \d{2}|\d{2}-\d{3}|\d{4}-\d{3}|(?:[A-Z]{1,2}-)?\d{4,5})\s+(\S.*)$/
const US_CITY = /^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/

/** the reverse of formatAddress for an address typed by hand; unknown shapes stay the street */
export function parseAddressText(value: string): string[] {
  const all = lines(value)
  for (let i = all.length - 1; i >= 0; i--) {
    const us = US_CITY.exec(all[i]!)
    if (us) {
      return [
        '',
        '',
        all.slice(0, i).join('\n'),
        us[1]!,
        us[2]!,
        us[3]!,
        all.slice(i + 1).join(', '),
      ]
    }
  }
  for (let i = all.length - 1; i >= 0; i--) {
    const eu = EU_CITY.exec(all[i]!)
    if (eu && i > 0) {
      const after = all.slice(i + 1)
      const region = after.length >= 2 ? after[0]! : ''
      const country = after.length >= 2 ? after.slice(1).join(', ') : (after[0] ?? '')
      return ['', '', all.slice(0, i).join('\n'), eu[2]!, region, eu[1]!, country]
    }
  }
  return ['', '', all.join('\n'), '', '', '', '']
}

function splitName(name: string): { first: string; last: string } {
  const comma = name.indexOf(',')
  if (comma > 0) return { last: name.slice(0, comma).trim(), first: name.slice(comma + 1).trim() }
  const words = name.trim().split(/\s+/)
  if (words.length < 2) return { first: words[0] ?? '', last: '' }
  return { first: words.slice(0, -1).join(' '), last: words[words.length - 1]! }
}

function read(comp: Component): Reading {
  const r: Reading = {
    card: undefined as unknown as ParsedCard,
    version: (comp.props.find((p) => p.name === 'VERSION')?.value ?? '').trim(),
    consumed: new Set(),
    notes: [],
    labels: [],
    emails: [],
    phones: [],
    addresses: [],
    companions: new Map(),
    company: false,
  }
  for (const p of comp.props) {
    if (p.group && COMPANIONS.has(p.name)) {
      const key = p.group.toLowerCase()
      r.companions.set(key, [...(r.companions.get(key) ?? []), p])
    }
  }

  let uid = ''
  let bday = ''
  let photo: string | undefined
  let kind = ''
  const noteTexts: string[] = []
  for (const p of comp.props) {
    switch (p.name) {
      case 'UID':
        uid ||= text(p).trim()
        break
      case 'FN':
        if (!r.fn && text(p).trim()) {
          r.fn = p
          r.consumed.add(p)
        } else if (!text(p).trim()) r.consumed.add(p)
        break
      case 'N':
        if (!r.n) {
          r.n = { line: p, raw: splitRaw(decoded(p), ';') }
          r.consumed.add(p)
        }
        break
      case 'ORG':
        if (!r.org && text(p).replace(/;/g, '').trim()) {
          r.org = { line: p, raw: splitRaw(decoded(p), ';') }
          r.consumed.add(p)
        } else if (!text(p).replace(/;/g, '').trim()) r.consumed.add(p)
        break
      case 'TITLE':
        if (!r.title && text(p).trim()) {
          r.title = p
          r.consumed.add(p)
        } else if (!text(p).trim()) r.consumed.add(p)
        break
      case 'BDAY':
        if (!r.bday) {
          const value = normalizeBirthday(text(p), p.params['X-APPLE-OMIT-YEAR']?.[0])
          if (value) {
            r.bday = p
            bday = value
            r.consumed.add(p)
          }
        }
        break
      case 'NOTE': {
        const note = text(p).trim()
        if (note) noteTexts.push(note)
        r.notes.push(p)
        r.consumed.add(p)
        break
      }
      case 'PHOTO':
        if (!r.photo) {
          photo = photoOf(p)
          if (photo) {
            r.photo = p
            r.consumed.add(p)
          }
        }
        break
      case 'LABEL':
        r.labels.push(p)
        r.consumed.add(p)
        break
      case 'KIND':
        kind ||= text(p).trim().toLowerCase()
        break
      case 'X-ADDRESSBOOKSERVER-KIND':
        kind ||= text(p).trim().toLowerCase()
        break
      case 'X-ABSHOWAS':
        if (/company/i.test(p.value)) r.company = true
        break
      case 'EMAIL': {
        r.consumed.add(p)
        const value = text(p)
          .trim()
          .replace(/^mailto:/i, '')
        if (value) r.emails.push({ value: { type: '', value }, line: p, rank: rankOf(p) })
        break
      }
      case 'TEL': {
        r.consumed.add(p)
        const value = text(p)
          .replace(/\s*[\r\n]+\s*/g, ' ')
          .trim()
          .replace(/^tel:/i, '')
        if (value) r.phones.push({ value: { type: '', value }, line: p, rank: rankOf(p) })
        break
      }
      case 'ADR': {
        r.consumed.add(p)
        const parts = splitStructured(decoded(p), ';')
        while (parts.length < 7) parts.push('')
        const value = formatAddress(parts)
        if (value) r.addresses.push({ value: { type: '', value }, line: p, rank: rankOf(p), parts })
        break
      }
    }
  }
  // types need the companions (labels) and are resolved once every line is known
  for (const [list, k] of [
    [r.emails, 'EMAIL'],
    [r.phones, 'TEL'],
    [r.addresses, 'ADR'],
  ] as const) {
    for (const item of list) item.value.type = typeOf(item.line, k, r)
    // the preferred value first: it is the one people mean ("the" address)
    list.sort((a, b) => a.rank - b.rank)
  }

  const organization = r.org
    ? unescapeText(r.org.raw[0] ?? '').trim() ||
      r.org.raw
        .slice(1)
        .map((s) => unescapeText(s).trim())
        .filter(Boolean)
        .join(', ')
    : ''
  let firstName = ''
  let lastName = ''
  let name = r.fn ? text(r.fn).trim() : ''
  if (r.n) {
    lastName = unescapeText(r.n.raw[0] ?? '').trim()
    firstName = unescapeText(r.n.raw[1] ?? '').trim()
  } else if (name && name !== organization && !name.includes('@')) {
    const split = splitName(name)
    firstName = split.first
    lastName = split.last
  }
  if (!name) {
    name =
      [firstName, lastName].filter(Boolean).join(' ') ||
      organization ||
      r.emails[0]?.value.value ||
      r.phones[0]?.value.value ||
      ''
  }

  r.card = {
    uid,
    name,
    firstName,
    lastName,
    emails: r.emails.map((i) => i.value),
    phones: r.phones.map((i) => i.value),
    organization,
    jobTitle: r.title ? text(r.title).trim() : '',
    birthday: bday,
    addresses: r.addresses.map((i) => i.value),
    note: noteTexts.join('\n'),
    ...(photo ? { photo } : {}),
    kind: kind || 'individual',
    version: r.version,
    raw: comp,
  }
  return r
}

function vcardComponents(text: string): Component[] {
  let roots: Component[]
  try {
    roots = parseComponents(prepare(String(text ?? '')))
  } catch {
    return []
  }
  const out: Component[] = []
  // a card missing its END swallows the next ones as children: flatten them back
  const visit = (comp: Component): void => {
    if (comp.name === 'VCARD') out.push(comp)
    for (const child of comp.children) visit(child)
  }
  roots.forEach(visit)
  return out
}

/** every usable card in a .vcf text (any version); garbage is skipped, never thrown */
export function parseVcards(text: string): ParsedCard[] {
  const out: ParsedCard[] = []
  for (const comp of vcardComponents(text)) {
    try {
      const card = read(comp).card
      if (card.name || card.kind === 'group') out.push(card)
    } catch {
      // one broken card must not cost the others
    }
  }
  return out
}

/** the first usable card, or null */
export function parseVcard(text: string): ParsedCard | null {
  return parseVcards(text)[0] ?? null
}

// ---- writing ----

type Fresh = {
  name: string
  value: string
  params?: Record<string, string[]>
  /** a custom label: written Apple-style as itemN.X-ABLabel */
  label?: string
}
type Piece = { line: ContentLine } | Fresh

function quoteParam(value: string): string {
  return /[;:,"]/.test(value) ? `"${value.replace(/"/g, "'")}"` : value
}

/** fold, with a fast path for the long ASCII lines photos make */
function foldLine(line: string): string {
  if (!/^[\x00-\x7f]*$/.test(line)) return fold(line)
  if (line.length <= 75) return line
  const chunks = [line.slice(0, 75)]
  for (let i = 75; i < line.length; i += 74) chunks.push(line.slice(i, i + 74))
  return chunks.join('\r\n ')
}

function renderLine(
  group: string | undefined,
  name: string,
  value: string,
  params: Record<string, string[]> = {},
): string {
  let head = group ? `${group}.${name}` : name
  for (const [key, list] of Object.entries(params)) {
    if (list.length) head += `;${key}=${list.map(quoteParam).join(',')}`
  }
  return foldLine(`${head}:${value}`)
}

/** a carried-over line, with 2.1 transfer encodings turned into 3.0 syntax */
function renderKept(line: ContentLine): string {
  const encoding = encodingOf(line)
  const params: Record<string, string[]> = {}
  for (const [key, list] of Object.entries(line.params)) {
    if (key === 'CHARSET' || key === 'ENCODING') continue
    if (key === 'TYPE') {
      const types = list.filter((t) => !PSEUDO_TYPES.has(t.trim().toLowerCase()))
      if (types.length) params[key] = types
      continue
    }
    params[key] = list
  }
  let value = line.value
  if (encoding === 'qp') {
    value = decodeQuotedPrintable(value, line.params.CHARSET?.[0]).replace(/\r\n|\r|\n/g, '\\n')
  } else if (encoding === 'b64') {
    params.ENCODING = ['b']
    value = value.replace(/\s+/g, '')
  }
  return renderLine(line.group, line.name, value, params)
}

function cleanList(list: LabeledValue[] | undefined, address = false): LabeledValue[] {
  return (Array.isArray(list) ? list : [])
    .map((item) => {
      const raw = String(item?.value ?? '')
      return {
        type: String(item?.type ?? '')
          .trim()
          .toLowerCase(),
        value: address ? lines(raw).join('\n') : raw.replace(/\s*[\r\n]+\s*/g, ' ').trim(),
      }
    })
    .filter((item) => item.value)
}

function validPhoto(photo: string | undefined): string | undefined {
  if (typeof photo !== 'string') return undefined
  const m = /^data:(image\/[\w.+-]+)(?:;[^,;]*)*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(photo.trim())
  return m ? `data:${m[1]!.toLowerCase()};base64,${m[2]!.replace(/\s+/g, '')}` : undefined
}

function freshPhoto(photo: string): Fresh | null {
  const m = /^data:image\/([\w.+-]+)(?:;[^,;]*)*;base64,(.+)$/i.exec(photo)
  if (!m) return null
  return { name: 'PHOTO', value: m[2]!, params: { ENCODING: ['b'], TYPE: [m[1]!.toUpperCase()] } }
}

function freshBirthday(birthday: string): Fresh {
  const yearless = /^--(\d{2})-(\d{2})$/.exec(birthday)
  // year-less the way iOS writes it into 3.0 cards; DAVx5 and Nextcloud read it too
  return yearless
    ? {
        name: 'BDAY',
        value: `1604-${yearless[1]}-${yearless[2]}`,
        params: { 'X-APPLE-OMIT-YEAR': ['1604'] },
      }
    : { name: 'BDAY', value: birthday }
}

function freshTyped(
  name: 'EMAIL' | 'TEL' | 'ADR',
  value: string,
  type: string,
  pref: boolean,
): Fresh {
  const types = name === 'EMAIL' ? ['INTERNET'] : []
  let label: string | undefined
  if (type && TYPE_PARAMS[name].has(type)) types.push(type.toUpperCase())
  else if (type) label = type.charAt(0).toUpperCase() + type.slice(1)
  if (pref) types.push('PREF')
  return {
    name,
    value,
    ...(types.length ? { params: { TYPE: types } } : {}),
    ...(label ? { label } : {}),
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * A vCard 3.0 text for the fields. With `existing` (the stored card, as text
 * or parsed), what the fields do not cover stays: unknown properties, the
 * middle name and honorifics in N, the department in ORG, Apple's labels —
 * and a value that did not change keeps its original line, parameters and all.
 */
export function serializeVcard(card: CardFields, existing?: Component | string): string {
  const comp = typeof existing === 'string' ? vcardComponents(existing)[0] : existing
  let old: Reading | undefined
  try {
    old = comp ? read(comp) : undefined
  } catch {
    old = undefined
  }
  const verbatim = !!old && old.version.startsWith('3')
  const v21 = !!old && !old.version.startsWith('3') && !old.version.startsWith('4')
  /** a raw (still escaped) component from the old card, re-escaped when it came from 2.1 */
  const rawPart = (part: string): string => (v21 ? escapeText(unescapeText(part)) : part)

  const firstName = String(card.firstName ?? '').trim()
  const lastName = String(card.lastName ?? '').trim()
  const organization = String(card.organization ?? '').trim()
  const jobTitle = String(card.jobTitle ?? '').trim()
  const emails = cleanList(card.emails).map((e) => ({
    ...e,
    value: e.value.replace(/^mailto:/i, ''),
  }))
  const phones = cleanList(card.phones)
  const addresses = cleanList(card.addresses, true)
  const birthday = normalizeBirthday(card.birthday ?? '')
  const note = String(card.note ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
  const photo = validPhoto(card.photo)
  const name =
    String(card.name ?? '')
      .replace(/\s*[\r\n]+\s*/g, ' ')
      .trim() ||
    [firstName, lastName].filter(Boolean).join(' ') ||
    organization ||
    emails[0]?.value ||
    phones[0]?.value ||
    ''
  const uid = String(card.uid ?? '')
    .replace(/[\r\n]+/g, '')
    .trim()

  const pieces: Piece[] = []
  const prev = old?.card

  // FN
  if (verbatim && old?.fn && prev?.name === name) pieces.push({ line: old.fn })
  else pieces.push({ name: 'FN', value: escapeText(name) })

  // N — always written; middle names, prefixes and suffixes survive a rename
  if (verbatim && old?.n && prev?.firstName === firstName && prev.lastName === lastName) {
    pieces.push({ line: old.n.line })
  } else {
    let first = firstName
    let last = lastName
    const company = old?.company || (!!organization && name === organization)
    if (!first && !last && name && !company && !name.includes('@')) {
      const split = splitName(name)
      first = split.first
      last = split.last
    }
    const rest = (old?.n?.raw.slice(2, 5) ?? []).map(rawPart)
    while (rest.length < 3) rest.push('')
    pieces.push({ name: 'N', value: [escapeText(last), escapeText(first), ...rest].join(';') })
  }

  // ORG — the department(s) after the name stay when only the name changes
  if (old?.org && prev?.organization === organization) {
    pieces.push(
      verbatim
        ? { line: old.org.line }
        : { name: 'ORG', value: old.org.raw.map(rawPart).join(';') },
    )
  } else if (organization) {
    const units =
      old?.org && unescapeText(old.org.raw[0] ?? '').trim() ? old.org.raw.slice(1).map(rawPart) : []
    pieces.push({ name: 'ORG', value: [escapeText(organization), ...units].join(';') })
  }

  // TITLE
  if (old?.title && prev?.jobTitle === jobTitle) {
    pieces.push(verbatim ? { line: old.title } : { name: 'TITLE', value: escapeText(jobTitle) })
  } else if (jobTitle) pieces.push({ name: 'TITLE', value: escapeText(jobTitle) })

  // EMAIL / TEL / ADR: an unchanged entry keeps its line (Apple's groups and
  // labels, extra types) unless its preference no longer fits the new order
  const listPieces = (
    kind: 'EMAIL' | 'TEL' | 'ADR',
    values: LabeledValue[],
    pool: Item[],
    freshValue: (v: LabeledValue, match: Item | undefined) => string,
  ): void => {
    const unused = [...pool]
    values.forEach((v, i) => {
      const at = unused.findIndex(
        (o) =>
          o.value.type === v.type &&
          (kind === 'EMAIL'
            ? o.value.value.toLowerCase() === v.value.toLowerCase()
            : o.value.value === v.value),
      )
      const match = at >= 0 ? unused.splice(at, 1)[0] : undefined
      if (match && verbatim && (i === 0 || match.rank > 100)) {
        pieces.push({ line: match.line })
        return
      }
      pieces.push(freshTyped(kind, freshValue(v, match), v.type, i === 0 && values.length > 1))
    })
  }
  listPieces('EMAIL', emails, old?.emails ?? [], (v) => escapeText(v.value))
  listPieces('TEL', phones, old?.phones ?? [], (v) => escapeText(v.value))
  listPieces('ADR', addresses, old?.addresses ?? [], (v, match) =>
    (match?.parts ?? parseAddressText(v.value)).map(escapeText).join(';'),
  )
  // a printed LABEL describes the old addresses; it stays only while they do
  if (old && sameJson(prev?.addresses, addresses)) {
    for (const line of old.labels) pieces.push({ line })
  }

  // BDAY
  if (old?.bday && prev?.birthday === birthday) {
    pieces.push(verbatim ? { line: old.bday } : freshBirthday(birthday))
  } else if (birthday) pieces.push(freshBirthday(birthday))

  // NOTE
  if (old && old.notes.length && prev?.note === note) {
    if (verbatim) for (const line of old.notes) pieces.push({ line })
    else if (note) pieces.push({ name: 'NOTE', value: escapeText(note) })
  } else if (note) pieces.push({ name: 'NOTE', value: escapeText(note) })

  // PHOTO (remote-URL photos are not modeled and stay below with the unknowns)
  if (old?.photo && prev?.photo === photo) {
    const kept = verbatim ? { line: old.photo } : photo ? freshPhoto(photo) : null
    if (kept) pieces.push(kept)
  } else if (photo) {
    const fresh = freshPhoto(photo)
    if (fresh) pieces.push(fresh)
  }

  // everything the model does not cover, in its original order
  const DROPPED = new Set(['BEGIN', 'END', 'VERSION', 'PRODID', 'UID', 'REV'])
  const unknown = old
    ? old.card.raw.props.filter(
        (p) =>
          !old!.consumed.has(p) && !DROPPED.has(p.name) && !(p.group && COMPANIONS.has(p.name)),
      )
    : []

  // groups still carried by kept lines; fresh labels get names that do not clash
  const alive = new Set<string>()
  for (const p of pieces) if ('line' in p && p.line.group) alive.add(p.line.group.toLowerCase())
  for (const p of unknown) if (p.group) alive.add(p.group.toLowerCase())
  let nextItem = 1
  const newGroup = (): string => {
    while (alive.has(`item${nextItem}`)) nextItem++
    alive.add(`item${nextItem}`)
    return `item${nextItem}`
  }

  const out = ['BEGIN:VCARD', 'VERSION:3.0', `PRODID:${VCARD_PRODID}`]
  if (uid) out.push(foldLine(`UID:${uid}`))
  const emitted = new Set<ContentLine>()
  const emitKept = (line: ContentLine): void => {
    if (emitted.has(line)) return
    emitted.add(line)
    out.push(renderKept(line))
    if (!line.group) return
    for (const companion of old?.companions.get(line.group.toLowerCase()) ?? []) {
      if (emitted.has(companion)) continue
      emitted.add(companion)
      out.push(renderKept(companion))
    }
  }
  for (const piece of pieces) {
    if ('line' in piece) {
      emitKept(piece.line)
    } else if (piece.label) {
      const group = newGroup()
      out.push(renderLine(group, piece.name, piece.value, piece.params))
      out.push(renderLine(group, 'X-ABLabel', escapeText(piece.label)))
    } else {
      out.push(renderLine(undefined, piece.name, piece.value, piece.params))
    }
  }
  for (const line of unknown) emitKept(line)
  out.push(`REV:${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`, 'END:VCARD')
  return out.join('\r\n') + '\r\n'
}
