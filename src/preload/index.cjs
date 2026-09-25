const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexProfileManager", {
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  getBrowserLinkStatus: () => ipcRenderer.invoke("browser-links:status"),
  enableBrowserLinks: () => ipcRenderer.invoke("browser-links:enable"),
  getEnvironmentReport: (codexAppPath) => ipcRenderer.invoke("environment:get", codexAppPath),
  pickCodexAppPath: () => ipcRenderer.invoke("dialog:pick-codex-app-path"),
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  getRuntimeStatus: () => ipcRenderer.invoke("profiles:runtime"),
  createProfile: (input) => ipcRenderer.invoke("profiles:create", input),
  permanentlyDeleteProfile: (profileId) => ipcRenderer.invoke("profiles:delete-permanently", profileId),
  generateLauncher: (profileId) => ipcRenderer.invoke("profiles:generate-launcher", profileId),
  revealLauncher: (profileId) => ipcRenderer.invoke("profiles:reveal-launcher", profileId),
  openProfile: (profileId) => ipcRenderer.invoke("profiles:open", profileId)
});
