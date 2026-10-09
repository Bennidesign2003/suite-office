// `npm run web`: build whatever is missing, then start Suite in the browser.
// A full `npm run build:all` runs only when an editor module has no build
// output yet; the web bridge itself is rebuilt every time (it takes a second).
// Rust is optional: without it everything but Sheets' workbook engine builds.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')

const required = [
  'apps/shell/out/main/index.js',
  ...['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'mail'].flatMap((m) => [
    `apps/${m}/out/renderer/index.html`,
    `apps/${m}/out/preload/index.js`,
  ]),
]
const missing = required.filter((p) => !existsSync(join(repo, p)))
const force = process.argv.includes('--rebuild')

function exitOnFailure(result) {
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/** a node script — never through a shell: cmd.exe splits "C:\Program Files\nodejs\node.exe" at the space */
function runNode(script) {
  exitOnFailure(spawnSync(process.execPath, [script], { cwd: repo, stdio: 'inherit' }))
}

/**
 * npm itself. Started via `npm run web`, npm tells us where its CLI script is
 * (npm_execpath), so it runs under this node without any shell. Otherwise
 * Windows only has npm.cmd, which needs one (the arguments here have no spaces).
 */
function runNpm(args) {
  const cli = process.env.npm_execpath
  if (cli && /\.c?js$/i.test(cli) && existsSync(cli)) {
    exitOnFailure(spawnSync(process.execPath, [cli, ...args], { cwd: repo, stdio: 'inherit' }))
    return
  }
  const windows = process.platform === 'win32'
  exitOnFailure(
    spawnSync(windows ? 'npm.cmd' : 'npm', args, { cwd: repo, stdio: 'inherit', shell: windows }),
  )
}

const fullBuild = force || missing.length > 0
if (fullBuild) {
  console.log(
    force
      ? 'Suite wird neu gebaut …'
      : `Suite ist noch nicht (vollständig) gebaut – baue jetzt (${missing.length} Teile fehlen) …`,
  )
  runNpm(['run', 'build:all'])
}

// Sheets' xlsx engine is Rust and optional for the rest of Suite (see
// apps/sheets/scripts/native-build.mjs). When Rust arrives after the first
// build, build just the engine instead of asking for a full rebuild.
const { findCargo, lastFailure, SIDECAR_BINARY } =
  await import('../sheets/scripts/native-build.mjs')
if (!fullBuild && !existsSync(SIDECAR_BINARY)) {
  const cargo = findCargo()
  if (cargo && lastFailure(cargo)) {
    console.warn(
      'Hinweis: Das xlsx-Modul von Sheets ließ sich beim letzten Versuch nicht bauen. ' +
        'Erneut versuchen: npm run native:build -w @genoffice/sheets',
    )
  } else if (cargo) {
    console.log('Rust gefunden – baue jetzt das xlsx-Modul von Sheets …')
    runNpm(['run', 'native:build', '-w', '@genoffice/sheets'])
  } else {
    console.warn(
      'Hinweis: Sheets kann ohne sein xlsx-Modul keine Arbeitsmappen öffnen. Dafür Rust ' +
        'installieren (https://rustup.rs) und `npm run web` neu starten – der Rest von Suite läuft auch so.',
    )
  }
}
runNode(join(here, 'build.mjs'))

const server = spawnSync(process.execPath, [join(here, 'dist', 'server.cjs')], {
  cwd: repo,
  stdio: 'inherit',
})
process.exit(server.status ?? 0)
