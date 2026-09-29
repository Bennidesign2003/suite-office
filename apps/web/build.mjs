// Bundles the web server (Node, CJS) and the page runtime (browser, IIFE).
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

await Promise.all([
  build({
    entryPoints: [join(here, 'src/server/main.ts')],
    outfile: join(here, 'dist/server.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: true,
    // resolved at runtime from node_modules; playwright-core carries its own assets
    external: ['playwright-core', 'ws', 'bufferutil', 'utf-8-validate'],
    logLevel: 'warning',
  }),
  build({
    entryPoints: [join(here, 'src/client/runtime.ts')],
    outfile: join(here, 'dist/client.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome110', 'firefox115', 'safari16'],
    sourcemap: 'inline',
    logLevel: 'warning',
  }),
])
console.log('web: built dist/server.cjs and dist/client.js')
