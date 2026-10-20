import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_LINK_PROTOCOL,
  listDesktopLinkTargets,
  restoreBrowserLinkHandler,
  sameDesktopTarget,
  sendCodexLinkToTarget,
  validateCodexLink
} from "./deep-links.js";
import { getEnvironmentReport } from "./environment.js";
import { APP_NAME, configurePathProvider } from "./paths.js";
import {
  acknowledgeProfileWarnings,
  createProfile,
  generateProfileLauncher,
  getProfileLauncherPath,
  getPreparationResults,
  getRuntimeStatus,
  listProfiles,
  openProfile,
  permanentlyDeleteProfile,
  previewProfileDefaults,
  retryProfilePreparation,
  refreshActiveProfileLaunchers
} from "./profile-service.js";
import type { CreateProfileInput, PreparationResult } from "../shared/types.js";
import { newWarnings } from "../shared/preparation-feedback.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let pendingOpenProfileId = getOpenProfileArg(process.argv);

let resolveProfilesReady: () => void;
const profilesReady = new Promise<void>((resolve) => { resolveProfilesReady = resolve; });

let resolveLinksReady: () => void;
const linksReady = new Promise<void>((resolve) => { resolveLinksReady = resolve; });
let browserLinkQueue = Promise.resolve();
const pendingBrowserLinks = new Set<string>();
let browserLinkTimer: ReturnType<typeof setTimeout> | undefined;
let quitting = false;

app.on("open-url", (event, url) => {
  event.preventDefault();
  queueBrowserLink(url);
});

app.setName(APP_NAME);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", (_event, argv) => {
  for (const argument of argv) {
    if (argument.startsWith("codex://")) queueBrowserLink(argument);
  }
  const profileId = getOpenProfileArg(argv);
  if (profileId) void openProfileFromArg(profileId);
  focusMainWindow();
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    title: APP_NAME,
    backgroundColor: "#f5f7fb",
    webPreferences: {
      preload: path.join(moduleDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(moduleDirectory, "../../dist/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("app:get-info", () => ({
    name: APP_NAME,
    version: app.getVersion(),
    buildKind: "local-personal" as const
  }));
  ipcMain.handle("environment:get", (_event, codexAppPath?: string) => getEnvironmentReport(codexAppPath));
  ipcMain.handle("dialog:pick-codex-app-path", async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose the official ChatGPT or Codex app",
      properties: ["openFile"],
      filters: [{ name: "macOS application", extensions: ["app"] }]
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("browser-links:status", () => app.isDefaultProtocolClient(CODEX_LINK_PROTOCOL));
  ipcMain.handle("browser-links:enable", () => enableBrowserLinks());
  ipcMain.handle("profiles:list", () => listProfiles());
  ipcMain.handle("profiles:runtime", () => getRuntimeStatus());
  ipcMain.handle("profiles:preparation", async () => { await profilesReady; return getPreparationResults(); });
  ipcMain.handle("profiles:preview-defaults", async (_event, profileId: string) => { await profilesReady; return previewProfileDefaults(profileId); });
  ipcMain.handle("profiles:retry-preparation", async (_event, profileId: string) => {
    await profilesReady;
    const result = await retryProfilePreparation(profileId);
    await notifyPreparation(result);
    return result;
  });
  ipcMain.handle("profiles:acknowledge-warnings", async (_event, profileId: string) => { await profilesReady; return acknowledgeProfileWarnings(profileId); });
  ipcMain.handle("profiles:create", async (_event, input: CreateProfileInput) => {
    await profilesReady;
    const result = await createProfile(input);
    await notifyPreparation(result.preparation);
    return result;
  });
  ipcMain.handle("profiles:delete-permanently", async (_event, profileId: string) => { await profilesReady; return permanentlyDeleteProfile(profileId); });
  ipcMain.handle("profiles:generate-launcher", async (_event, profileId: string) => { await profilesReady; return generateProfileLauncher(profileId); });
  ipcMain.handle("profiles:reveal-launcher", async (_event, profileId: string) => {
    shell.showItemInFolder(await getProfileLauncherPath(profileId));
    return { ok: true };
  });
  ipcMain.handle("profiles:open", async (_event, profileId: string) => {
    await profilesReady;
    const result = await openProfile(profileId);
    await notifyPreparation(result.preparation);
    return result;
  });
}

async function notifyPreparation(result: PreparationResult, background = false): Promise<void> {
  const warnings = newWarnings(result);
  if (!warnings.length || (!background && mainWindow?.isFocused())) return;
  const profile = (await listProfiles()).find((item) => item.id === result.profileId);
  showNotification(`Setup warning: ${profile?.name ?? result.profileId}`, warnings.map((message) => message.message).join("\n"));
}

function showNotification(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body: body.slice(0, 1000) }).show();
  } catch {
    // OS notification availability must not change preparation or launch success.
    // The same diagnostics remain available in the profile's persistent result.
  }
}

function notifyStartupPreparation(results: PreparationResult[]): void {
  if (mainWindow?.isFocused()) return;
  const blocked = results.filter((result) => result.status === "blocked").length;
  const pending = results.filter((result) => result.status === "deferred").length;
  const warnings = results.filter((result) => result.status === "warning").length;
  if (blocked || results.some((result) => newWarnings(result).length)) {
    showNotification("Profile setup needs attention", `${blocked} blocked, ${pending} pending, ${warnings} with warnings. Open the launcher to review the profiles.`);
  }
}

function enableBrowserLinks(): boolean {
  if (!app.isPackaged) throw new Error("Browser links require the packaged Codex Personal Launcher app.");
  app.setAsDefaultProtocolClient(CODEX_LINK_PROTOCOL);
  return app.isDefaultProtocolClient(CODEX_LINK_PROTOCOL);
}

async function maintainBrowserLinks(): Promise<void> {
  try {
    await restoreBrowserLinkHandler(app, async () => listDesktopLinkTargets(await listProfiles()));
  } catch {
    console.warn("[personal-launcher] Could not restore browser link routing; will retry.");
  } finally {
    if (!quitting) browserLinkTimer = setTimeout(() => void maintainBrowserLinks(), 2000);
  }
}

function queueBrowserLink(value: string): void {
  let url: string;
  try {
    url = validateCodexLink(value);
  } catch {
    return;
  }
  if (pendingBrowserLinks.has(url)) return;
  pendingBrowserLinks.add(url);
  browserLinkQueue = browserLinkQueue.then(async () => {
    await linksReady;
    await routeBrowserLink(url);
  }).catch(() => {
    dialog.showErrorBox("Browser Link Failed", "Could not deliver the browser link. Keep the originating app open and try connecting again.");
  }).finally(() => {
    pendingBrowserLinks.delete(url);
  });
}

async function routeBrowserLink(url: string): Promise<void> {
  const targets = await listDesktopLinkTargets(await listProfiles());
  if (!targets.length) {
    dialog.showErrorBox("No App Is Running", "Open the main app or your personal profile, then start the connection again from that window.");
    return;
  }
  focusMainWindow();
  const labels = targets.map((target) => targets.filter((other) => other.name === target.name).length > 1
    ? `${target.name} (${target.pid})` : target.name);
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "Open Browser Link",
    message: "Which app started this browser flow?",
    detail: "Choose the window where you started connecting. The link does not identify its account or profile.",
    buttons: ["Cancel", ...labels],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  const target = targets[response - 1];
  if (!target) return;
  const currentTargets = await listDesktopLinkTargets(await listProfiles());
  if (!currentTargets.some((current) => sameDesktopTarget(target, current))) {
    dialog.showErrorBox("App Closed", "The selected window is no longer running. Reopen it and start the connection again.");
    return;
  }
  await sendCodexLinkToTarget(target, url);
}

function getOpenProfileArg(argv: string[]): string | null {
  const inline = argv.find((argument) => argument.startsWith("--open-profile="));
  if (inline) return inline.slice("--open-profile=".length).trim() || null;
  const index = argv.indexOf("--open-profile");
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  return value && !value.startsWith("--") ? value : null;
}

async function openProfileFromArg(profileId: string): Promise<void> {
  try {
    await profilesReady;
    const result = await openProfile(profileId);
    await notifyPreparation(result.preparation, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not open the personal profile.";
    dialog.showErrorBox("Personal Profile Launch Failed", message);
  }
}

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  app.focus({ steal: true });
  mainWindow.focus();
}

void app.whenReady().then(() => {
  configurePathProvider({
    home: () => app.getPath("home"),
    appData: () => app.getPath("appData"),
    userData: () => app.getPath("userData")
  });
  registerIpc();
  if (app.isPackaged) {
    enableBrowserLinks();
    void maintainBrowserLinks();
  }
  resolveLinksReady();
  for (const argument of process.argv) {
    if (argument.startsWith("codex://")) queueBrowserLink(argument);
  }
  createWindow();
  void refreshActiveProfileLaunchers().then(notifyStartupPreparation).catch((error) => {
    dialog.showErrorBox("Profile Setup Failed", error instanceof Error ? error.message : String(error));
  }).finally(() => resolveProfilesReady());
  if (pendingOpenProfileId) {
    const profileId = pendingOpenProfileId;
    pendingOpenProfileId = null;
    void openProfileFromArg(profileId);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Profile apps run independently. Closing this window must not stop their
  // browser return-link routing when the official app takes the handler back.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  clearTimeout(browserLinkTimer);
});
