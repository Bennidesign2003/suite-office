import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  fsPathFromUrlPath,
  handledSchemes,
  isServableFsPath,
  protoRequestUrl,
  setOrigins,
  toWebUrl,
  withWebContentsId,
} from '../src/server/urls'

setOrigins({ app: '', content: 'http://localhost:4318', internal: 'http://127.0.0.1:4317' })
handledSchemes.add('genoffice-app')
handledSchemes.add('md-asset')

describe('web url mapping', () => {
  it('serves app pages from the app origin and content schemes from the content port', () => {
    expect(toWebUrl('genoffice-app://docs/index.html?mode=tab')).toBe(
      '/__proto/genoffice-app/docs/index.html?mode=tab',
    )
    expect(toWebUrl('md-asset://%2Ftmp%2Fa.png')).toBe(
      'http://localhost:4318/__proto/md-asset/%2Ftmp%2Fa.png',
    )
  })

  it('passes web and unknown schemes through', () => {
    expect(toWebUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(toWebUrl('data:text/html,hi')).toBe('data:text/html,hi')
    expect(toWebUrl('docnav://heading/3')).toBe('docnav://heading/3')
  })

  it('maps file URLs and only serves directories a page was loaded from', () => {
    const file = '/opt/suite/apps/shell/out/renderer/index.html'
    const web = toWebUrl(pathToFileURL(file).toString())
    expect(web).toBe('/__fs/opt/suite/apps/shell/out/renderer/index.html')
    expect(fsPathFromUrlPath(web)).toBe(file)
    expect(isServableFsPath('/opt/suite/apps/shell/out/renderer/assets/a.js')).toBe(true)
    expect(isServableFsPath('/opt/suite/apps/shell/out/main/index.js')).toBe(false)
    expect(isServableFsPath('/etc/passwd')).toBe(false)
  })

  it('does not let encoded dot segments escape a served directory', () => {
    const path = fsPathFromUrlPath(
      '/__fs/opt/suite/apps/shell/out/renderer/%2E%2E/%2E%2E/main/index.js',
    )
    expect(path).toBe('/opt/suite/apps/shell/main/index.js')
    expect(isServableFsPath(path!)).toBe(false)
  })

  it('rebuilds the URL a protocol handler expects', () => {
    expect(protoRequestUrl('/__proto/genoffice-app/sheets/index.html?x=1')).toEqual({
      scheme: 'genoffice-app',
      url: 'genoffice-app://sheets/index.html?x=1',
    })
    expect(protoRequestUrl('/__proto/unknown/x')).toBeNull()
  })

  it('marks the webContents on relative and absolute page URLs', () => {
    expect(withWebContentsId('/__fs/a/index.html?mode=tab#top', 7)).toBe(
      '/__fs/a/index.html?mode=tab&__wc=7#top',
    )
    expect(withWebContentsId('http://127.0.0.1:4317/x', 2)).toBe('http://127.0.0.1:4317/x?__wc=2')
    expect(withWebContentsId('data:text/html,x', 2)).toBe('data:text/html,x')
  })
})
