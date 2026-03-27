/**
 * Preload script - Bridge between renderer and main process
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xquisito', {
  // Configuración
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (branchId, syncToken) => ipcRenderer.invoke('save-config', { branchId, syncToken }),
  saveFullConfig: (configData) => ipcRenderer.invoke('save-full-config', configData),
  testSql: () => ipcRenderer.invoke('test-sql'),
  testSqlWithConfig: (sqlConfig) => ipcRenderer.invoke('test-sql-with-config', sqlConfig),

  // Agente
  getStatus: () => ipcRenderer.invoke('get-status'),
  startAgent: () => ipcRenderer.invoke('start-agent'),
  stopAgent: () => ipcRenderer.invoke('stop-agent'),

  // Ventana
  minimize: () => ipcRenderer.invoke('minimize-window'),
  hideWindow: () => ipcRenderer.invoke('hide-window'),

  // SQL Onboarding
  sqlOnboarding: {
    getStatus: () => ipcRenderer.invoke('sql-onboarding-status'),
    run: (params) => ipcRenderer.invoke('sql-onboarding-run', params),
    testWindows: (params) => ipcRenderer.invoke('sql-onboarding-test-windows', params),
    testSql: (params) => ipcRenderer.invoke('sql-onboarding-test-sql', params),
    createUser: (params) => ipcRenderer.invoke('sql-onboarding-create-user', params),
    saveWindows: (params) => ipcRenderer.invoke('sql-onboarding-save-windows', params),
    saveSql: (params) => ipcRenderer.invoke('sql-onboarding-save-sql', params),
    clear: () => ipcRenderer.invoke('sql-onboarding-clear'),
    discover: () => ipcRenderer.invoke('sql-onboarding-discover'),
    getDiagnostics: () => ipcRenderer.invoke('sql-onboarding-diagnostics')
  },

  // Eventos
  onLoadConfig: (callback) => ipcRenderer.on('load-config', (event, config) => callback(config)),
  onAgentStatus: (callback) => ipcRenderer.on('agent-status', (event, status) => callback(status))
});
