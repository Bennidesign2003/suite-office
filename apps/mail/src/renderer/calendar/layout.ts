/**
 * Placement of overlapping events, kept free of React and the DOM so it can be
 * unit-tested: side-by-side columns for timed events in a day column, and
 * stacked rows for bars that span days (all-day lane, month weeks).
 */

export interface TimedItem {
  id: string
  /** any consistent unit, e.g. minutes since midnight */
  start: number
  end: number
}

export interface ColumnPlacement {
  /** 0-based column inside the item's overlap cluster */
  column: number
  /** columns the cluster is divided into */
  columns: number
  /** how many columns the item may widen into (≥ 1) because nothing there overlaps it */
  span: number
}

function byStartThenLonger<T extends { id: string; start: number; end: number }>(
  a: T,
  b: T,
): number {
  return a.start - b.start || b.end - a.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * Outlook/Google-style column layout. Events that overlap, directly or
 * through a chain, form a cluster; each takes the first column free at its
 * start, the cluster is split into as many columns as it needed, and an
 * event then stretches right over columns that stay free for its whole time.
 *
 * `minLength` is the shortest length an item is drawn with: a 5-minute event
 * drawn 20 minutes tall must not be put on top of the one after it.
 */
export function layoutColumns(items: TimedItem[], minLength = 0): Map<string, ColumnPlacement> {
  const result = new Map<string, ColumnPlacement>()
  const sorted = items
    .map((it) => ({ id: it.id, start: it.start, end: Math.max(it.end, it.start + minLength) }))
    .sort(byStartThenLonger)

  let cluster: Array<{ id: string; start: number; end: number; column: number }> = []
  let columnEnds: number[] = []
  let clusterEnd = -Infinity

  const flush = (): void => {
    const columns = columnEnds.length
    for (const item of cluster) {
      let span = 1
      for (let c = item.column + 1; c < columns; c++) {
        const blocked = cluster.some(
          (other) => other.column === c && other.start < item.end && other.end > item.start,
        )
        if (blocked) break
        span++
      }
      result.set(item.id, { column: item.column, columns, span })
    }
    cluster = []
    columnEnds = []
  }

  for (const item of sorted) {
    if (item.start >= clusterEnd && cluster.length) flush()
    let column = columnEnds.findIndex((end) => end <= item.start)
    if (column < 0) {
      column = columnEnds.length
      columnEnds.push(item.end)
    } else {
      columnEnds[column] = item.end
    }
    cluster.push({ ...item, column })
    clusterEnd = cluster.length === 1 ? item.end : Math.max(clusterEnd, item.end)
  }
  if (cluster.length) flush()
  return result
}

export interface SpanItem {
  id: string
  /** first cell (e.g. day index in the week) */
  start: number
  /** cell after the last one (exclusive) */
  end: number
  /** tie-break among bars with the same cells, lower first (e.g. all-day, then by time) */
  rank?: number
}

/**
 * Rows for bars across cells: earlier bars first, longer ones before shorter
 * ones starting the same day, each in the lowest row free for its whole span.
 */
export function packRows(items: SpanItem[]): Map<string, number> {
  const rows = new Map<string, number>()
  const rowEnds: number[] = []
  const ordered = [...items].sort(
    (a, b) =>
      a.start - b.start ||
      b.end - a.end ||
      (a.rank ?? 0) - (b.rank ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  for (const item of ordered) {
    const end = Math.max(item.end, item.start + 1)
    let row = rowEnds.findIndex((e) => e <= item.start)
    if (row < 0) {
      row = rowEnds.length
      rowEnds.push(end)
    } else {
      rowEnds[row] = end
    }
    rows.set(item.id, row)
  }
  return rows
}

/**
 * Which bars fit into cells that hold at most `capacity` rows. When a cell
 * overflows, its last row is given to a "+N more" link, so bars in that row
 * are hidden in every cell they cross. Returns the hidden count per cell.
 */
export function fitRows(
  items: SpanItem[],
  rows: Map<string, number>,
  cells: number,
  capacity: number,
): { visible: Set<string>; hidden: number[] } {
  const perCell: string[][] = Array.from({ length: cells }, () => [])
  for (const item of items) {
    for (
      let c = Math.max(0, item.start);
      c < Math.min(cells, Math.max(item.end, item.start + 1));
      c++
    )
      perCell[c]!.push(item.id)
  }
  const overflows = perCell.map((ids) => ids.some((id) => (rows.get(id) ?? 0) >= capacity))
  const visible = new Set<string>()
  for (const item of items) {
    const row = rows.get(item.id) ?? 0
    let limit = capacity
    for (
      let c = Math.max(0, item.start);
      c < Math.min(cells, Math.max(item.end, item.start + 1));
      c++
    )
      if (overflows[c]) limit = capacity - 1
    if (row < limit) visible.add(item.id)
  }
  const hidden = perCell.map((ids) => ids.filter((id) => !visible.has(id)).length)
  return { visible, hidden }
}
