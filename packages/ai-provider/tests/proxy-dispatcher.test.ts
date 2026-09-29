import { describe, expect, it } from 'vitest'
import { noProxyList } from '../src/proxy-dispatcher'

describe('proxy dispatcher', () => {
  it('always keeps the loopback daemon off the proxy', () => {
    const list = noProxyList({}).split(',')
    expect(list).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1']))
  })

  it('keeps NO_PROXY entries and extra direct hosts', () => {
    const list = noProxyList({ NO_PROXY: 'intranet.local', no_proxy: '10.0.0.5' }, [
      'gpu-box',
    ]).split(',')
    expect(list).toEqual(
      expect.arrayContaining(['intranet.local', '10.0.0.5', 'gpu-box', '127.0.0.1']),
    )
  })
})
