import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SidecarMissingError, XlsxSidecarClient } from '../src/main/xlsx-sidecar-client'
// @ts-expect-error — plain .mjs build script without type declarations
import { diagnose } from '../scripts/native-build.mjs'

const script = join(__dirname, '..', 'scripts', 'native-build.mjs')

describe('missing xlsx sidecar', () => {
  it('rejects requests with the caller-provided explanation instead of ENOENT', async () => {
    const client = new XlsxSidecarClient(join(tmpdir(), 'no-such-dir', 'xlsx-sidecar'), {
      missingMessage: () => 'Tabellen-Modul fehlt',
    })
    const failure = await client.open('/tmp/whatever.xlsx').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SidecarMissingError)
    expect((failure as Error).message).toBe('Tabellen-Modul fehlt')
    expect((failure as SidecarMissingError).code).toBe('SIDECAR_MISSING')
  })

  it('names Rust and the binary path by default', async () => {
    const path = join(tmpdir(), 'no-such-dir', 'xlsx-sidecar')
    const failure = await new XlsxSidecarClient(path).open('/tmp/x.xlsx').catch((e: unknown) => e)
    expect((failure as Error).message).toContain('https://rustup.rs')
    expect((failure as Error).message).toContain(path)
  })
})

describe('native-build without Rust', () => {
  // a PATH with node but without cargo, and a HOME without ~/.cargo
  const env = (extra: Record<string, string>) => {
    const home = mkdtempSync(join(tmpdir(), 'no-rust-home-'))
    const path = (process.env.PATH ?? '')
      .split(delimiter)
      .filter((dir) => !/cargo|rustup/i.test(dir))
      .join(delimiter)
    const base: Record<string, string> = { PATH: path, HOME: home, USERPROFILE: home }
    if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot
    return { ...base, ...extra }
  }

  it('keeps the build going for a local build', () => {
    const run = spawnSync(process.execPath, [script], { env: env({}), encoding: 'utf8' })
    expect(run.status).toBe(0)
  })

  it('fails for packaging and CI', () => {
    for (const extra of [{ SUITE_REQUIRE_NATIVE: '1' }, { CI: 'true' }]) {
      const run = spawnSync(process.execPath, [script], { env: env(extra), encoding: 'utf8' })
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('rustup')
    }
  })

  it('explains the usual compile failures', () => {
    expect(diagnose('error: linker `link.exe` not found', 'win32')).toMatch(/Build Tools/)
    expect(diagnose('xcrun: error: invalid active developer path', 'darwin')).toMatch(
      /xcode-select --install/,
    )
    expect(diagnose('error: linker `cc` not found', 'linux')).toMatch(/build-essential/)
    expect(diagnose('feature `edition2024` is required', 'linux')).toMatch(/rustup update/)
    expect(diagnose('warning: spurious network error (3 tries remaining)', 'linux')).toMatch(
      /Internet/,
    )
    expect(diagnose('error[E0425]: cannot find value `x` in this scope', 'linux')).toBeNull()
  })
})
