import type { MailApi } from '../shared/ipc'
import type { PimApi } from '../shared/pim'

declare global {
  interface Window {
    mailApi: MailApi
    pimApi: PimApi
  }
}

export {}
