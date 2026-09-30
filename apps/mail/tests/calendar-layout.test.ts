import { describe, expect, it } from 'vitest'
import {
  fitRows,
  layoutColumns,
  packRows,
  type SpanItem,
  type TimedItem,
} from '../src/renderer/calendar/layout'

const item = (id: string, start: number, end: number): TimedItem => ({ id, start, end })

describe('layoutColumns', () => {
  it('returns nothing for no events', () => {
    expect(layoutColumns([]).size).toBe(0)
  })

  it('gives events that do not overlap the full width', () => {
    const out = layoutColumns([item('a', 540, 600), item('b', 600, 660), item('c', 720, 780)])
    for (const id of ['a', 'b', 'c'])
      expect(out.get(id)).toEqual({ column: 0, columns: 1, span: 1 })
  })

  it('puts two overlapping events side by side', () => {
    const out = layoutColumns([item('a', 540, 660), item('b', 600, 720)])
    expect(out.get('a')).toEqual({ column: 0, columns: 2, span: 1 })
    expect(out.get('b')).toEqual({ column: 1, columns: 2, span: 1 })
  })

  it('reuses a column once it is free and splits the whole chain alike', () => {
    // a overlaps b, b overlaps c, a and c touch only through b
    const out = layoutColumns([item('a', 0, 60), item('b', 30, 90), item('c', 60, 120)])
    expect(out.get('a')).toEqual({ column: 0, columns: 2, span: 1 })
    expect(out.get('b')).toEqual({ column: 1, columns: 2, span: 1 })
    expect(out.get('c')).toEqual({ column: 0, columns: 2, span: 1 })
  })

  it('stretches an event over columns that stay free', () => {
    const out = layoutColumns([
      item('a', 0, 180),
      item('b', 0, 60),
      item('c', 0, 60),
      item('d', 60, 120),
    ])
    expect(out.get('a')).toEqual({ column: 0, columns: 3, span: 1 })
    expect(out.get('b')).toEqual({ column: 1, columns: 3, span: 1 })
    expect(out.get('c')).toEqual({ column: 2, columns: 3, span: 1 })
    // d takes b's column after b ends and widens into c's, which is free by then
    expect(out.get('d')).toEqual({ column: 1, columns: 3, span: 2 })
  })

  it('puts the longer of two events starting together first', () => {
    const out = layoutColumns([item('short', 0, 30), item('long', 0, 120)])
    expect(out.get('long')!.column).toBe(0)
    expect(out.get('short')!.column).toBe(1)
  })

  it('starts a new cluster after a gap', () => {
    const out = layoutColumns([item('a', 0, 60), item('b', 30, 90), item('c', 90, 150)])
    expect(out.get('c')).toEqual({ column: 0, columns: 1, span: 1 })
  })

  it('respects the drawn minimum height of very short events', () => {
    const tiny = [item('a', 0, 0), item('b', 5, 30)]
    expect(layoutColumns(tiny).get('a')!.columns).toBe(1)
    const drawn = layoutColumns(tiny, 20)
    expect(drawn.get('a')).toEqual({ column: 0, columns: 2, span: 1 })
    expect(drawn.get('b')).toEqual({ column: 1, columns: 2, span: 1 })
  })

  it('does not depend on the input order', () => {
    const list = [item('a', 0, 180), item('b', 0, 60), item('c', 0, 60), item('d', 60, 120)]
    const forward = layoutColumns(list)
    const backward = layoutColumns([...list].reverse())
    for (const it of list) expect(backward.get(it.id)).toEqual(forward.get(it.id))
  })

  it('never lets overlapping events share or cover a column (random days)', () => {
    let seed = 42
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let round = 0; round < 200; round++) {
      const items = Array.from({ length: 1 + rand(12) }, (_, i) => {
        const start = rand(48) * 30
        return item(`e${i}`, start, start + 15 + rand(8) * 30)
      })
      const out = layoutColumns(items)
      expect(out.size).toBe(items.length)
      for (const a of items) {
        const pa = out.get(a.id)!
        expect(pa.span).toBeGreaterThanOrEqual(1)
        expect(pa.column + pa.span).toBeLessThanOrEqual(pa.columns)
        for (const b of items) {
          if (a === b || !(a.start < b.end && b.start < a.end)) continue
          const pb = out.get(b.id)!
          const aCols = [pa.column, pa.column + pa.span - 1]
          const bCols = [pb.column, pb.column + pb.span - 1]
          const shared = aCols[0]! <= bCols[1]! && bCols[0]! <= aCols[1]!
          expect(shared, `${a.id} and ${b.id} overlap in time and columns`).toBe(false)
        }
      }
    }
  })
})

describe('packRows', () => {
  const bar = (id: string, start: number, end: number, rank?: number): SpanItem => ({
    id,
    start,
    end,
    ...(rank === undefined ? {} : { rank }),
  })

  it('stacks overlapping bars and reuses free rows', () => {
    const rows = packRows([bar('a', 0, 3), bar('b', 1, 2), bar('c', 3, 5), bar('d', 2, 4)])
    expect(rows.get('a')).toBe(0)
    expect(rows.get('b')).toBe(1)
    expect(rows.get('d')).toBe(1)
    expect(rows.get('c')).toBe(0)
  })

  it('puts longer bars above shorter ones starting the same day', () => {
    const rows = packRows([bar('one', 0, 1), bar('week', 0, 7)])
    expect(rows.get('week')).toBe(0)
    expect(rows.get('one')).toBe(1)
  })

  it('orders single-day chips by rank', () => {
    const rows = packRows([
      bar('late', 2, 3, 900),
      bar('early', 2, 3, 100),
      bar('allday', 2, 3, -1),
    ])
    expect(rows.get('allday')).toBe(0)
    expect(rows.get('early')).toBe(1)
    expect(rows.get('late')).toBe(2)
  })

  it('gives a zero-length bar one cell', () => {
    const rows = packRows([bar('a', 2, 2), bar('b', 2, 3)])
    expect(new Set(rows.values()).size).toBe(2)
  })
})

describe('fitRows', () => {
  it('shows everything that fits', () => {
    const items = [
      { id: 'a', start: 0, end: 1 },
      { id: 'b', start: 0, end: 1 },
    ]
    const fit = fitRows(items, packRows(items), 7, 3)
    expect([...fit.visible].sort()).toEqual(['a', 'b'])
    expect(fit.hidden).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('keeps the last row for "+N more" when a day overflows', () => {
    const items = [
      { id: 'a', start: 0, end: 1, rank: 1 },
      { id: 'b', start: 0, end: 1, rank: 2 },
      { id: 'c', start: 0, end: 1, rank: 3 },
      { id: 'd', start: 0, end: 1, rank: 4 },
    ]
    const fit = fitRows(items, packRows(items), 7, 3)
    expect([...fit.visible].sort()).toEqual(['a', 'b'])
    expect(fit.hidden[0]).toBe(2)
  })

  it('hides a bar in the overflow row on every day it crosses', () => {
    const items = [
      { id: 'x1', start: 0, end: 1 },
      { id: 'x2', start: 0, end: 1 },
      { id: 'x3', start: 0, end: 1 },
      { id: 'week', start: 0, end: 3 },
    ]
    const rows = packRows(items)
    expect(rows.get('week')).toBe(0)
    const fit = fitRows(items, rows, 7, 2)
    // day 0 holds four bars in two rows: the week bar stays, one more row is "+3"
    expect(fit.visible.has('week')).toBe(true)
    expect(fit.hidden[0]).toBe(3)
    expect(fit.hidden[1]).toBe(0)

    const crowded = [
      { id: 'w1', start: 0, end: 3 },
      { id: 'w2', start: 0, end: 3 },
      { id: 'd0', start: 0, end: 1 },
    ]
    const fit2 = fitRows(crowded, packRows(crowded), 7, 2)
    // w2 sits in the last row and day 0 overflows, so it goes into "+N" on all its days
    expect(fit2.visible.has('w2')).toBe(false)
    expect(fit2.hidden.slice(0, 3)).toEqual([2, 1, 1])
  })

  it('hides everything behind "+N" when only one row fits', () => {
    const items = [
      { id: 'a', start: 4, end: 5 },
      { id: 'b', start: 4, end: 5 },
    ]
    const fit = fitRows(items, packRows(items), 7, 1)
    expect(fit.visible.size).toBe(0)
    expect(fit.hidden[4]).toBe(2)
  })
})
