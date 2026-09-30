import { describe, expect, it } from 'vitest'
import {
  currentToken,
  formatRecipient,
  isLikelyEmail,
  replaceToken,
  splitRecipients,
} from '../src/renderer/contacts/address-tokens'
import { parseRecipient } from '../src/renderer/format'

describe('splitRecipients', () => {
  it('splits on commas and semicolons and trims', () => {
    expect(splitRecipients('a@x.de, b@y.de;c@z.de')).toEqual(['a@x.de', 'b@y.de', 'c@z.de'])
    expect(splitRecipients('  a@x.de  ')).toEqual(['a@x.de'])
  })

  it('drops empty parts and handles empty input', () => {
    expect(splitRecipients('')).toEqual([])
    expect(splitRecipients(' , ;, ')).toEqual([])
    expect(splitRecipients('a@x.de,, ,b@y.de, ')).toEqual(['a@x.de', 'b@y.de'])
  })

  it('keeps commas inside quoted names together', () => {
    expect(splitRecipients('"Doe, John" <j@x.de>, Anna <a@x.de>')).toEqual([
      '"Doe, John" <j@x.de>',
      'Anna <a@x.de>',
    ])
  })

  it('handles escaped quotes inside quoted names', () => {
    expect(splitRecipients('"Say \\"hi\\", Bob" <b@x.de>, c@x.de')).toEqual([
      '"Say \\"hi\\", Bob" <b@x.de>',
      'c@x.de',
    ])
  })

  it('does not split inside angle brackets or comments', () => {
    expect(splitRecipients('Odd <a,b@x.de>, c@x.de')).toEqual(['Odd <a,b@x.de>', 'c@x.de'])
    expect(splitRecipients('a@x.de (Büro, 2. OG), b@x.de')).toEqual([
      'a@x.de (Büro, 2. OG)',
      'b@x.de',
    ])
  })

  it('treats an unterminated quote as one recipient instead of crashing', () => {
    expect(splitRecipients('"Doe, John <j@x.de>, b@x.de')).toEqual(['"Doe, John <j@x.de>, b@x.de'])
  })

  it('round-trips with parseRecipient', () => {
    const parsed = splitRecipients('"Schmidt, Anna" <anna@firma.de>; bob@x.de').map(parseRecipient)
    expect(parsed).toEqual([
      { name: 'Schmidt, Anna', email: 'anna@firma.de' },
      { name: '', email: 'bob@x.de' },
    ])
  })
})

describe('currentToken', () => {
  it('finds the recipient under the caret', () => {
    const value = 'a@x.de, jo'
    expect(currentToken(value, value.length)).toEqual({ start: 7, end: 10, text: 'jo' })
    expect(currentToken(value, 2)).toEqual({ start: 0, end: 6, text: 'a@x.de' })
  })

  it('returns the whole segment when the caret is in the middle', () => {
    const value = 'a@x.de, bob, c@z.de'
    const token = currentToken(value, 10)
    expect(token.text).toBe('bob')
    expect(value.slice(token.start, token.end)).toBe(' bob')
  })

  it('gives an empty token right after a separator', () => {
    expect(currentToken('a@x.de, ', 8)).toEqual({ start: 7, end: 8, text: '' })
    expect(currentToken('a@x.de,', 7)).toEqual({ start: 7, end: 7, text: '' })
    expect(currentToken('', 0)).toEqual({ start: 0, end: 0, text: '' })
  })

  it('ignores separators inside quotes', () => {
    const value = '"Doe, John" <j@x.de>, "Mey'
    expect(currentToken(value, value.length).text).toBe('"Mey')
    expect(currentToken(value, 3).text).toBe('"Doe, John" <j@x.de>')
  })

  it('clamps an out-of-range caret', () => {
    expect(currentToken('a, b', 99).text).toBe('b')
    expect(currentToken('a, b', -5).text).toBe('a')
    expect(currentToken('a, b', Number.NaN).text).toBe('b')
  })
})

describe('replaceToken', () => {
  it('completes the last recipient and adds a separator', () => {
    const value = 'a@x.de, jo'
    const next = replaceToken(value, currentToken(value, value.length), 'John Doe <john@x.de>')
    expect(next).toBe('a@x.de, John Doe <john@x.de>, ')
  })

  it('completes the first recipient of an empty field', () => {
    expect(replaceToken('an', currentToken('an', 2), 'Anna <a@x.de>')).toBe('Anna <a@x.de>, ')
    expect(replaceToken('  an', currentToken('  an', 4), 'Anna <a@x.de>')).toBe('Anna <a@x.de>, ')
  })

  it('keeps what follows when completing a recipient in the middle', () => {
    const value = 'a@x.de, bo, c@z.de'
    const next = replaceToken(value, currentToken(value, 10), 'Bob <b@y.de>')
    expect(next).toBe('a@x.de, Bob <b@y.de>, c@z.de')
    expect(splitRecipients(next)).toEqual(['a@x.de', 'Bob <b@y.de>', 'c@z.de'])
  })

  it('keeps a semicolon separator the user typed', () => {
    const value = 'a@x.de;jo'
    expect(replaceToken(value, currentToken(value, value.length), 'j@x.de')).toBe(
      'a@x.de; j@x.de, ',
    )
  })

  it('works with a quoted name containing a comma', () => {
    const value = '"Doe, John" <j@x.de>, an'
    const next = replaceToken(value, currentToken(value, value.length), '"Meyer, Anna" <a@x.de>')
    expect(next).toBe('"Doe, John" <j@x.de>, "Meyer, Anna" <a@x.de>, ')
    expect(splitRecipients(next)).toHaveLength(2)
  })
})

describe('formatRecipient', () => {
  it('writes name and address', () => {
    expect(formatRecipient('Anna Schmidt', 'anna@firma.de')).toBe('Anna Schmidt <anna@firma.de>')
  })

  it('returns the bare address without a name or when the name is the address', () => {
    expect(formatRecipient('', 'anna@firma.de')).toBe('anna@firma.de')
    expect(formatRecipient('  ', 'anna@firma.de')).toBe('anna@firma.de')
    expect(formatRecipient('Anna@Firma.de', 'anna@firma.de')).toBe('anna@firma.de')
  })

  it('quotes names with commas and other specials', () => {
    expect(formatRecipient('Schmidt, Anna', 'a@x.de')).toBe('"Schmidt, Anna" <a@x.de>')
    expect(formatRecipient('Dr. Anna Schmidt', 'a@x.de')).toBe('"Dr. Anna Schmidt" <a@x.de>')
    expect(formatRecipient('Team (Vertrieb)', 'v@x.de')).toBe('"Team (Vertrieb)" <v@x.de>')
    expect(formatRecipient('a@b', 'v@x.de')).toBe('"a@b" <v@x.de>')
  })

  it('drops quotes and backslashes inside a quoted name', () => {
    expect(formatRecipient('Anna "Nana", Schmidt', 'a@x.de')).toBe('"Anna Nana, Schmidt" <a@x.de>')
    expect(formatRecipient('"', 'a@x.de')).toBe('a@x.de')
  })

  it('never lets a line break or angle bracket through', () => {
    const out = formatRecipient('Evil\r\nBcc: x@y.de', 'a@x.de\n')
    expect(out).not.toMatch(/[\r\n]/)
    expect(out).toBe('"Evil Bcc: x@y.de" <a@x.de>')
    expect(formatRecipient('Anna', '<a@x.de>')).toBe('Anna <a@x.de>')
  })

  it('keeps umlauts unquoted', () => {
    expect(formatRecipient('Jürgen Müller', 'j@müller.de')).toBe('Jürgen Müller <j@müller.de>')
  })

  it('produces something splitRecipients and parseRecipient read back', () => {
    const line = [formatRecipient('Doe, John', 'j@x.de'), formatRecipient('Anna', 'a@x.de')].join(
      ', ',
    )
    expect(splitRecipients(line).map(parseRecipient)).toEqual([
      { name: 'Doe, John', email: 'j@x.de' },
      { name: 'Anna', email: 'a@x.de' },
    ])
  })
})

describe('isLikelyEmail', () => {
  it('accepts ordinary addresses', () => {
    for (const ok of [
      'anna@firma.de',
      'first.last+tag@sub.example.co.uk',
      'x_y-z@a-b.io',
      'jürgen@müller.de',
      '  padded@x.de  ',
    ]) {
      expect(isLikelyEmail(ok), ok).toBe(true)
    }
  })

  it('rejects things that are not addresses', () => {
    for (const bad of [
      '',
      'anna',
      'anna@',
      '@firma.de',
      'anna@firma',
      'anna@@firma.de',
      'an na@firma.de',
      'anna@firma..de',
      'anna@.firma.de',
      'anna@firma.de.',
      '.anna@firma.de',
      'anna.@firma.de',
      'an..na@firma.de',
      'anna@-firma.de',
      'anna@firma.d',
      'anna@1.2.3.4',
      'Anna <anna@firma.de>',
      'a,b@firma.de',
    ]) {
      expect(isLikelyEmail(bad), bad).toBe(false)
    }
  })
})
