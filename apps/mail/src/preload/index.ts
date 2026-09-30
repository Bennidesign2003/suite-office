import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AiStreamChunk } from '@genoffice/ai-provider'
import { MAIL_CHANNELS, type MailApi, type MailModule, type UiTheme } from '../shared/ipc'
import { PIM_CHANNELS, type PimApi, type PimChange } from '../shared/pim'

function subscribe<T>(channel: string, handler: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T) => handler(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: MailApi = {
  getLanguage: () => ipcRenderer.invoke('app:get-language'),
  onLanguageChanged: (handler) => subscribe<string>('app:language-changed', handler),
  getTheme: () => ipcRenderer.invoke('app:get-theme'),
  onThemeChanged: (handler) => subscribe<UiTheme>('app:theme-changed', handler),

  listAccounts: () => ipcRenderer.invoke(MAIL_CHANNELS.listAccounts),
  saveAccount: (input) => ipcRenderer.invoke(MAIL_CHANNELS.saveAccount, input),
  removeAccount: (id) => ipcRenderer.invoke(MAIL_CHANNELS.removeAccount, id),
  testAccount: (input) => ipcRenderer.invoke(MAIL_CHANNELS.testAccount, input),
  guessServers: (email) => ipcRenderer.invoke(MAIL_CHANNELS.guessServers, email),

  listFolders: (accountId) => ipcRenderer.invoke(MAIL_CHANNELS.listFolders, accountId),
  listMessages: (accountId, folder, options) =>
    ipcRenderer.invoke(MAIL_CHANNELS.listMessages, accountId, folder, options),
  getMessage: (accountId, folder, uid) =>
    ipcRenderer.invoke(MAIL_CHANNELS.getMessage, accountId, folder, uid),
  setFlags: (accountId, folder, uids, flag, on) =>
    ipcRenderer.invoke(MAIL_CHANNELS.setFlags, accountId, folder, uids, flag, on),
  moveMessages: (accountId, folder, uids, target) =>
    ipcRenderer.invoke(MAIL_CHANNELS.moveMessages, accountId, folder, uids, target),
  deleteMessages: (accountId, folder, uids) =>
    ipcRenderer.invoke(MAIL_CHANNELS.deleteMessages, accountId, folder, uids),
  saveAttachment: (accountId, folder, uid, index) =>
    ipcRenderer.invoke(MAIL_CHANNELS.saveAttachment, accountId, folder, uid, index),
  pickAttachments: () => ipcRenderer.invoke(MAIL_CHANNELS.pickAttachments),
  send: (mail) => ipcRenderer.invoke(MAIL_CHANNELS.send, mail),

  initialModule: () => ipcRenderer.invoke(MAIL_CHANNELS.initialModule),
  onShowModule: (handler) => subscribe<MailModule>(MAIL_CHANNELS.showModule, handler),

  getAiSettings: () => ipcRenderer.invoke('ai:get-settings'),
  aiStream: (request) => ipcRenderer.invoke('ai:stream', request),
  aiStreamCancel: (requestId) => ipcRenderer.invoke('ai:stream-cancel', requestId),
  onAiStream: (handler) => subscribe<AiStreamChunk>('ai:stream-chunk', handler),
}

const pimApi: PimApi = {
  listSources: () => ipcRenderer.invoke(PIM_CHANNELS.listSources),
  saveSource: (input) => ipcRenderer.invoke(PIM_CHANNELS.saveSource, input),
  removeSource: (id) => ipcRenderer.invoke(PIM_CHANNELS.removeSource, id),
  testSource: (input) => ipcRenderer.invoke(PIM_CHANNELS.testSource, input),
  guessDav: (email) => ipcRenderer.invoke(PIM_CHANNELS.guessDav, email),
  sync: (sourceId) => ipcRenderer.invoke(PIM_CHANNELS.sync, sourceId),

  listCalendars: () => ipcRenderer.invoke(PIM_CHANNELS.listCalendars),
  updateCalendar: (id, patch) => ipcRenderer.invoke(PIM_CHANNELS.updateCalendar, id, patch),
  createCalendar: (sourceId, name, color) =>
    ipcRenderer.invoke(PIM_CHANNELS.createCalendar, sourceId, name, color),
  listEvents: (range) => ipcRenderer.invoke(PIM_CHANNELS.listEvents, range),
  getEvent: (calendarId, uid, occurrenceStart) =>
    ipcRenderer.invoke(PIM_CHANNELS.getEvent, calendarId, uid, occurrenceStart),
  saveEvent: (input) => ipcRenderer.invoke(PIM_CHANNELS.saveEvent, input),
  deleteEvent: (calendarId, uid, scope, occurrenceStart) =>
    ipcRenderer.invoke(PIM_CHANNELS.deleteEvent, calendarId, uid, scope, occurrenceStart),
  importIcs: (calendarId) => ipcRenderer.invoke(PIM_CHANNELS.importIcs, calendarId),
  exportIcs: (calendarId) => ipcRenderer.invoke(PIM_CHANNELS.exportIcs, calendarId),

  listAddressBooks: () => ipcRenderer.invoke(PIM_CHANNELS.listAddressBooks),
  listContacts: (query) => ipcRenderer.invoke(PIM_CHANNELS.listContacts, query),
  saveContact: (input) => ipcRenderer.invoke(PIM_CHANNELS.saveContact, input),
  deleteContact: (addressBookId, uid) =>
    ipcRenderer.invoke(PIM_CHANNELS.deleteContact, addressBookId, uid),
  importVcf: (addressBookId) => ipcRenderer.invoke(PIM_CHANNELS.importVcf, addressBookId),
  exportVcf: (addressBookId) => ipcRenderer.invoke(PIM_CHANNELS.exportVcf, addressBookId),
  suggestAddresses: (query, limit) =>
    ipcRenderer.invoke(PIM_CHANNELS.suggestAddresses, query, limit),
  rememberRecipients: (addresses) => ipcRenderer.invoke(PIM_CHANNELS.rememberRecipients, addresses),

  respondInvitation: (response) => ipcRenderer.invoke(PIM_CHANNELS.respondInvitation, response),

  onChanged: (handler) => subscribe<PimChange>(PIM_CHANNELS.changed, handler),
}

contextBridge.exposeInMainWorld('mailApi', api)
contextBridge.exposeInMainWorld('pimApi', pimApi)
