// `npm run shell`: start the desktop app (Electron) on the built shell.
//
// Ubuntu 23.10+ (AppArmor) blocks the unprivileged user namespaces Chromium
// sandboxes with, and the fallback SUID helper in node_modules is not
// root-owned after `npm install` — Electron then aborts with "The SUID sandbox
// helper binary was found, but is not configured correctly". Only in exactly
// that case this launcher passes --no-sandbox (as the e2e helpers do), and
// says so; everywhere else Electron starts unchanged.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')

function readSysctl(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

function sandboxBlocked() {
  if (process.platform !== 'linux') return false
  const helper = join(dirname(electron), 'chrome-sandbox')
  if (existsSync(helper)) {
    const st = statSync(helper)
    if (st.uid === 0 && (st.mode & 0o4000) !== 0) return false
  }
  return (
    readSysctl('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1' ||
    readSysctl('/proc/sys/kernel/unprivileged_userns_clone') === '0'
  )
}

const args = [join(repo, 'apps', 'shell'), ...process.argv.slice(2)]
if (sandboxBlocked() && !args.includes('--no-sandbox')) {
  console.warn(
    'Hinweis: Dieses Linux erlaubt Electrons Sandbox nicht (AppArmor) – Suite startet mit --no-sandbox.',
  )
  args.push('--no-sandbox')
}
const child = spawn(electron, args, { stdio: 'inherit', cwd: repo })
// Ctrl+C / kill on this launcher must close the app, not orphan it
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
