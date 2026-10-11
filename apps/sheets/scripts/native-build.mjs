// `npm run native:build -w @genoffice/sheets`: compile the xlsx sidecar (Rust).
//
// Only Sheets needs the sidecar — without it workbooks cannot be opened, but
// Docs, Slides, PDF, Mail and the rest work fine. So a missing Rust toolchain
// (or a failed compile) must not abort `npm run web` / `npm run build:all` for
// someone who just wants to try Suite: print what is missing and how to fix
// it, and carry on. Packaging and CI stay strict (SUITE_REQUIRE_NATIVE=1, CI,
// or --strict), where a Sheets without its engine must never ship.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sheets = resolve(here, '..')
const crate = join(sheets, 'native', 'xlsx-engine')
const exe = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
export const SIDECAR_BINARY = join(crate, 'target', 'release', exe)
// a failed compile is remembered, so `npm run web` does not retry it on every
// start (on a Mac without the Xcode tools each try pops the install dialog)
const FAILED_MARKER = join(crate, 'target', '.suite-build-failed.json')

export function cargoVersion(cargo) {
  const out = spawnSync(cargo, ['--version'], { encoding: 'utf8' })
  return out.status === 0 ? out.stdout.trim() : ''
}

/** the last failed build with this toolchain, or null (none, or Rust changed since) */
export function lastFailure(cargo) {
  try {
    const failed = JSON.parse(readFileSync(FAILED_MARKER, 'utf8'))
    return failed && failed.cargo === cargoVersion(cargo) ? failed : null
  } catch {
    return null
  }
}

function rememberFailure(cargo, code) {
  try {
    mkdirSync(dirname(FAILED_MARKER), { recursive: true })
    writeFileSync(
      FAILED_MARKER,
      JSON.stringify({ cargo: cargoVersion(cargo), code, at: new Date().toISOString() }),
    )
  } catch {
    // best effort: without it the next start simply tries again
  }
}

const truthy = (value) => !!value && !/^(0|false|no)$/i.test(value)
const strict =
  process.argv.includes('--strict') ||
  truthy(process.env.SUITE_REQUIRE_NATIVE) ||
  truthy(process.env.CI)

/**
 * The cargo to run: the one on PATH, else rustup's default location — a
 * terminal opened before installing Rust does not have ~/.cargo/bin on its
 * PATH yet, and asking the user to restart it is an avoidable round trip.
 */
export function findCargo() {
  const onPath = spawnSync('cargo', ['--version'], { stdio: 'ignore' })
  if (onPath.status === 0) return 'cargo'
  const home = process.env.CARGO_HOME || join(homedir(), '.cargo')
  const candidate = join(home, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
  if (existsSync(candidate)) {
    const direct = spawnSync(candidate, ['--version'], { stdio: 'ignore' })
    if (direct.status === 0) return candidate
  }
  return null
}

/** What usually went wrong, judged from the end of cargo's output. */
export function diagnose(output, platform = process.platform) {
  if (/edition2024|edition = "2024"|feature `edition2024`|requires rustc \d/i.test(output)) {
    return 'Die installierte Rust-Version ist zu alt (nötig: 1.88 oder neuer). Aktualisieren mit: rustup update'
  }
  if (/link\.exe|msvc targets depend on the msvc linker/i.test(output)) {
    return (
      'Unter Windows braucht Rust die „Visual Studio Build Tools“ mit der Auswahl ' +
      '„Desktopentwicklung mit C++“: https://visualstudio.microsoft.com/de/visual-cpp-build-tools/'
    )
  }
  if (/xcrun: error|xcode-select|invalid active developer path/i.test(output)) {
    return 'Unter macOS fehlen die Xcode-Befehlszeilentools. Installieren mit: xcode-select --install'
  }
  if (/linker `?cc`? not found|could not find.*\bcc\b|error: linker/i.test(output)) {
    return platform === 'linux'
      ? 'Es fehlt ein C-Linker. Installieren z. B. mit: sudo apt install build-essential (Fedora: sudo dnf install gcc)'
      : 'Es fehlt ein C-Linker für Rust (siehe Fehlermeldung oben).'
  }
  if (
    /failed to (download|fetch|get|load source)|could not resolve|network|spurious|timed out|ssl|certificate/i.test(
      output,
    )
  ) {
    return 'cargo konnte die Rust-Bibliotheken nicht laden (Internet/Proxy prüfen) — einfach noch einmal versuchen.'
  }
  return null
}

function banner(lines) {
  const rule = '─'.repeat(Math.min(Math.max(...lines.map((l) => l.length)) + 4, 100))
  console.warn(`\n${rule}`)
  for (const line of lines) console.warn(line ? `  ${line}` : '')
  console.warn(`${rule}\n`)
}

const INSTALL_HINT = [
  'Rust installieren (einmalig, ein paar Minuten):',
  '  macOS / Linux:  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh',
  '  Windows:        winget install Rustlang.Rustup   (oder https://rustup.rs)',
  'Danach einfach wieder `npm run web` starten — das Tabellen-Modul wird dann automatisch gebaut.',
]

function giveUp(lines, code = 1) {
  if (strict) {
    banner(['FEHLER: Das xlsx-Modul von Sheets (Rust) konnte nicht gebaut werden.', ...lines])
    process.exit(code)
  }
  banner([
    'Hinweis: Das xlsx-Modul von Sheets (Rust) fehlt — der Build läuft trotzdem weiter.',
    'Docs, Slides, PDF, Markdown, HTML und Mail funktionieren; Sheets kann ohne das Modul',
    'aber keine Arbeitsmappen öffnen oder anlegen.',
    '',
    ...lines,
  ])
  process.exit(0)
}

function run(cargo) {
  return new Promise((resolveRun) => {
    const args = [
      'build',
      '--release',
      '--manifest-path',
      join(crate, 'Cargo.toml'),
      // cargo reads .cargo/config.toml from the working directory, not from
      // the manifest's folder — pass it explicitly (static MSVC CRT on Windows)
      '--config',
      join(crate, '.cargo', 'config.toml'),
    ]
    if (process.stderr.isTTY) args.push('--color', 'always')
    const child = spawn(cargo, args, { cwd: sheets, stdio: ['inherit', 'inherit', 'pipe'] })
    let tail = ''
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      tail = (tail + chunk.toString()).slice(-16_000)
    })
    child.on('error', (err) => resolveRun({ code: 1, tail: String(err?.message ?? err) }))
    child.on('close', (code) => resolveRun({ code: code ?? 1, tail }))
  })
}

async function main() {
  const cargo = findCargo()
  if (!cargo) {
    // packaging must not ship a binary that may predate the current sources
    if (!strict && existsSync(SIDECAR_BINARY)) {
      console.warn('cargo nicht gefunden — das vorhandene xlsx-Modul wird weiterverwendet.')
      return
    }
    giveUp(['cargo (Rust) wurde nicht gefunden.', '', ...INSTALL_HINT], 127)
    return
  }
  if (!existsSync(join(crate, 'target'))) {
    console.log(
      'Baue das xlsx-Modul von Sheets (Rust). Beim ersten Mal dauert das einige Minuten …',
    )
  }
  const { code, tail } = await run(cargo)
  if (code === 0) {
    rmSync(FAILED_MARKER, { force: true })
    return
  }
  rememberFailure(cargo, code)
  const hint = diagnose(tail)
  giveUp(
    [
      `cargo build ist fehlgeschlagen (Exit-Code ${code}, Details oben).`,
      ...(hint ? ['', hint] : []),
      '',
      'Nach dem Beheben: `npm run native:build -w @genoffice/sheets` (oder `npm run web:rebuild`).',
    ],
    code,
  )
}

// imported by start.mjs for findCargo/SIDECAR_BINARY; only build when run directly
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
