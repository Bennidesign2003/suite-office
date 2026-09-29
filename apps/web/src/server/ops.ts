import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'
import type { FsEntry, FsListing, FsPlace } from '../shared/protocol'
import { app } from './electron/app'

/**
 * Server-side filesystem access for the in-page file dialog. The dialog runs
 * in the root page only and exists to pick paths the main process then opens
 * or writes — the same trust the native dialog had.
 */

function listDir(input: string, showHidden: boolean): FsListing {
  let dir = resolve(input || homedir())
  while (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  const entries: FsEntry[] = []
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!showHidden && dirent.name.startsWith('.')) continue
    const full = join(dir, dirent.name)
    try {
      const st = statSync(full)
      entries.push({
        name: dirent.name,
        dir: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size,
        mtime: st.mtimeMs,
      })
    } catch {
      // broken symlink or no permission: not selectable anyway
    }
  }
  entries.sort((a, b) =>
    a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }),
  )
  const parent = dirname(dir)
  return { dir, parent: parent === dir ? null : parent, sep, entries }
}

function places(): FsPlace[] {
  const home = homedir()
  const out: FsPlace[] = [{ label: 'Home', path: home }]
  for (const [label, name] of [
    ['Dokumente', 'documents'],
    ['Schreibtisch', 'desktop'],
    ['Downloads', 'downloads'],
  ] as const) {
    try {
      const path = app.getPath(name)
      if (existsSync(path)) out.push({ label, path })
    } catch {
      // unknown on this platform
    }
  }
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGH') {
      const root = `${letter}:\\`
      if (existsSync(root)) out.push({ label: `${letter}:`, path: root })
    }
  } else {
    out.push({ label: '/', path: parse(home).root })
  }
  return out
}

/** where files dropped into the browser land (webUtils.getPathForFile) */
export function uploadRoot(): string {
  let base: string
  try {
    base = app.getPath('documents')
  } catch {
    base = homedir()
  }
  return join(base, 'Suite Uploads')
}

export function runOp(op: string, args: unknown[]): unknown {
  switch (op) {
    case 'uploadDir': {
      const dir = uploadRoot()
      mkdirSync(dir, { recursive: true })
      return dir
    }
    case 'fs.list':
      return listDir(String(args[0] ?? ''), !!args[1])
    case 'fs.places':
      return places()
    case 'fs.mkdir': {
      const target = join(String(args[0]), String(args[1]))
      mkdirSync(target, { recursive: false })
      return target
    }
    case 'fs.exists': {
      const target = String(args[0])
      if (!existsSync(target)) return null
      return statSync(target).isDirectory() ? 'dir' : 'file'
    }
    default:
      throw new Error(`unknown op ${op}`)
  }
}
