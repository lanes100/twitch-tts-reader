const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  startOAuth: (cfg) => ipcRenderer.invoke('oauth:start', cfg),
  startBot: (cfg) => ipcRenderer.invoke('bot:start', cfg),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
  getBotStatus: () => ipcRenderer.invoke('bot:status'),
  getVoices: () => ipcRenderer.invoke('voices:list'),
  getAuthStatus: () => ipcRenderer.invoke('auth:status'),
  onLog: (cb) => ipcRenderer.on('bot:log', (_e, msg) => cb(msg)),
  onExit: (cb) => ipcRenderer.on('bot:exit', (_e, code) => cb(code)),
  onStarted: (cb) => ipcRenderer.on('bot:started', (_e) => cb()),
  onOAuthSuccess: (cb) => ipcRenderer.on('oauth:success', (_e, data) => cb(data)),
  onOAuthError: (cb) => ipcRenderer.on('oauth:error', (_e, data) => cb(data)),
  onThemeChange: (cb) => ipcRenderer.on('theme:changed', (_e, theme) => cb(theme)),
  onBotRunning: (cb) => ipcRenderer.on('bot:running', (_e, running) => cb(!!running)),
});
