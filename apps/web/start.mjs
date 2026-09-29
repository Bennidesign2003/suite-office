// `npm run web`: build whatever is missing, then start Suite in the browser.
// A full `npm run build:all` runs only when an editor module has no build
// output yet; the web bridge itself is rebuilt every time (it takes a second).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const required = [
  'apps/shell/out/main/index.js',
  ...['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'mail'].flatMap((m) => [
    `apps/${m}/out/renderer/index.html`,
    `apps/${m}/out/preload/index.js`,
  ]),
]
const missing = required.filter((p) => !existsSync(join(repo, p)))
const force = process.argv.includes('--rebuild')

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: repo,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (force || missing.length > 0) {
  console.log(
    force
      ? 'Suite wird neu gebaut …'
      : `Suite ist noch nicht (vollständig) gebaut – baue jetzt (${missing.length} Teile fehlen) …`,
  )
  run(npm, ['run', 'build:all'])
}
run(process.execPath, [join(here, 'build.mjs')])

const server = spawnSync(process.execPath, [join(here, 'dist', 'server.cjs')], {
  cwd: repo,
  stdio: 'inherit',
})
process.exit(server.status ?? 0)
