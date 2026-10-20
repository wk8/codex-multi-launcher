import { contextBridge, ipcRenderer } from "electron";
import type { CodexApi, CreateProfileInput } from "../shared/types.js";

const api: CodexApi = {
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  getBrowserLinkStatus: () => ipcRenderer.invoke("browser-links:status"),
  enableBrowserLinks: () => ipcRenderer.invoke("browser-links:enable"),
  getEnvironmentReport: (codexAppPath?: string) => ipcRenderer.invoke("environment:get", codexAppPath),
  pickCodexAppPath: () => ipcRenderer.invoke("dialog:pick-codex-app-path"),
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  getRuntimeStatus: () => ipcRenderer.invoke("profiles:runtime"),
  getPreparationResults: () => ipcRenderer.invoke("profiles:preparation"),
  previewProfileDefaults: (profileId: string) => ipcRenderer.invoke("profiles:preview-defaults", profileId),
  retryProfilePreparation: (profileId: string) => ipcRenderer.invoke("profiles:retry-preparation", profileId),
  acknowledgeProfileWarnings: (profileId: string) => ipcRenderer.invoke("profiles:acknowledge-warnings", profileId),
  createProfile: (input: CreateProfileInput) => ipcRenderer.invoke("profiles:create", input),
  permanentlyDeleteProfile: (profileId: string) => ipcRenderer.invoke("profiles:delete-permanently", profileId),
  generateLauncher: (profileId: string) => ipcRenderer.invoke("profiles:generate-launcher", profileId),
  revealLauncher: (profileId: string) => ipcRenderer.invoke("profiles:reveal-launcher", profileId),
  openProfile: (profileId: string) => ipcRenderer.invoke("profiles:open", profileId)
};

contextBridge.exposeInMainWorld("codexProfileManager", api);
