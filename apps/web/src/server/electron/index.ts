/**
 * The `electron` module as the built main process sees it when Suite runs as
 * a web server. `main.ts` routes `require('electron')` here.
 */
import { app } from './app'
import { BrowserWindow, session, WebContentsView } from './contents'
import { dialog } from './dialog'
import { ipcMain } from './ipc'
import { MenuItem, MenuShim } from './menu'
import {
  autoUpdater,
  clipboard,
  crashReporter,
  desktopCapturer,
  globalShortcut,
  nativeTheme,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Tray,
  webContentsModule,
  webFrameMain,
} from './misc'
import { nativeImage } from './native-image'
import { net, protocol } from './protocol'
import { tolerant } from './tolerant'

const electron = {
  app,
  autoUpdater,
  BaseWindow: BrowserWindow,
  BrowserWindow,
  clipboard,
  crashReporter,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu: MenuShim,
  MenuItem,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  webContents: webContentsModule,
  WebContentsView,
  View: WebContentsView,
  webFrameMain,
}

export default tolerant(electron, 'electron')
