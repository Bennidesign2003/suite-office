/**
 * The content-line syntax iCalendar (RFC 5545) and vCard (RFC 6350) share:
 * folded lines, `NAME;PARAM=a,b;PARAM2="quoted":value`, BEGIN/END nesting and
 * backslash escaping of TEXT values. ics.ts and vcard.ts build their models
 * on top of this.
 */

export interface ContentLine {
  /** upper case, e.g. "DTSTART"; a vCard group prefix ("item1.") is dropped into `group` */
  name: string
  group?: string
  /** upper-case keys; values keep their case, quotes removed */
  params: Record<string, string[]>
  /** raw value: not unescaped (TEXT unescaping depends on the property) */
  value: string
}

export interface Component {
  /** upper case: VCALENDAR, VEVENT, VTIMEZONE, VCARD … */
  name: string
  props: ContentLine[]
  children: Component[]
}

/** undo line folding (CRLF or LF followed by one space/tab) */
export function unfold(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1)
    } else if (line.length > 0) {
      out.push(line)
    }
  }
  return out
}

export function parseContentLine(line: string): ContentLine | null {
  // name and params end at the first ':' outside double quotes
  let i = 0
  let inQuotes = false
  for (; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuotes = !inQuotes
    else if (c === ':' && !inQuotes) break
  }
  if (i >= line.length) return null
  const head = line.slice(0, i)
  const value = line.slice(i + 1)

  const parts: string[] = []
  let current = ''
  inQuotes = false
  for (const c of head) {
    if (c === '"') inQuotes = !inQuotes
    if (c === ';' && !inQuotes) {
      parts.push(current)
      current = ''
    } else current += c
  }
  parts.push(current)

  let rawName = parts[0]!.trim()
  let group: string | undefined
  const dot = rawName.lastIndexOf('.')
  if (dot > 0) {
    group = rawName.slice(0, dot)
    rawName = rawName.slice(dot + 1)
  }
  if (!rawName) return null
  const params: Record<string, string[]> = {}
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=')
    // vCard 2.1 bare params ("TEL;CELL:…") mean TYPE=CELL
    const key = (eq < 0 ? 'TYPE' : part.slice(0, eq)).trim().toUpperCase()
    const rawValue = eq < 0 ? part : part.slice(eq + 1)
    const values: string[] = []
    let v = ''
    let q = false
    for (const c of rawValue) {
      if (c === '"') {
        q = !q
        continue
      }
      if (c === ',' && !q) {
        values.push(v)
        v = ''
      } else v += c
    }
    values.push(v)
    ;(params[key] ??= []).push(...values)
  }
  return { name: rawName.toUpperCase(), group, params, value }
}

/** parse every top-level component (a file may hold several VCALENDARs / VCARDs) */
export function parseComponents(text: string): Component[] {
  const roots: Component[] = []
  const stack: Component[] = []
  for (const raw of unfold(text)) {
    const line = parseContentLine(raw)
    if (!line) continue
    if (line.name === 'BEGIN') {
      const comp: Component = { name: line.value.trim().toUpperCase(), props: [], children: [] }
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(comp)
      else roots.push(comp)
      stack.push(comp)
    } else if (line.name === 'END') {
      const name = line.value.trim().toUpperCase()
      // tolerate unbalanced files: close up to the matching BEGIN
      const at = stack.map((c) => c.name).lastIndexOf(name)
      if (at >= 0) stack.length = at
    } else {
      stack[stack.length - 1]?.props.push(line)
    }
  }
  return roots
}

export function prop(comp: Component, name: string): ContentLine | undefined {
  return comp.props.find((p) => p.name === name)
}

export function props(comp: Component, name: string): ContentLine[] {
  return comp.props.filter((p) => p.name === name)
}

export function param(line: ContentLine | undefined, name: string): string | undefined {
  return line?.params[name.toUpperCase()]?.[0]
}

/** TEXT value unescaping: \n \N \, \; \\ */
export function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\:])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/** split a structured value (N, ADR, …) at unescaped separators, then unescape each part */
export function splitStructured(value: string, separator: ';' | ','): string[] {
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
  return out.map(unescapeText)
}

function quoteParam(value: string): string {
  return /[;:,"]/.test(value) ? `"${value.replace(/"/g, "'")}"` : value
}

/** one property line, folded at 75 octets without splitting a UTF-8 sequence */
export function serializeLine(
  name: string,
  value: string,
  params: Record<string, string | string[] | undefined> = {},
): string {
  let head = name.toUpperCase()
  for (const [key, v] of Object.entries(params)) {
    if (v === undefined || (Array.isArray(v) && v.length === 0)) continue
    const list = Array.isArray(v) ? v : [v]
    head += `;${key.toUpperCase()}=${list.map(quoteParam).join(',')}`
  }
  return fold(`${head}:${value}`)
}

export function fold(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line
  const chunks: string[] = []
  let current = ''
  let bytes = 0
  let limit = 75
  for (const ch of line) {
    const size = encoder.encode(ch).length
    if (bytes + size > limit) {
      chunks.push(current)
      current = ''
      bytes = 0
      // continuation lines start with a space, which counts toward the 75
      limit = 74
    }
    current += ch
    bytes += size
  }
  if (current) chunks.push(current)
  return chunks.join('\r\n ')
}

/** build a component; `lines` are already-serialized property lines */
export function serializeComponent(name: string, lines: string[], children: string[] = []): string {
  return [`BEGIN:${name}`, ...lines, ...children, `END:${name}`].join('\r\n')
}
