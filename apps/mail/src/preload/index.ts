import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AiStreamChunk } from '@genoffice/ai-provider'
import { MAIL_CHANNELS, type MailApi, type UiTheme } from '../shared/ipc'

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

  getAiSettings: () => ipcRenderer.invoke('ai:get-settings'),
  aiStream: (request) => ipcRenderer.invoke('ai:stream', request),
  aiStreamCancel: (requestId) => ipcRenderer.invoke('ai:stream-cancel', requestId),
  onAiStream: (handler) => subscribe<AiStreamChunk>('ai:stream-chunk', handler),
}

contextBridge.exposeInMainWorld('mailApi', api)
