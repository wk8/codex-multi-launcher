import { EventEmitter } from "node:events";
import path from "node:path";

export const calls = { dialogs: [], notifications: [], windows: [], ipc: new Map(), focused: true, notificationsSupported: true, notificationFails: false };
let ready;
const readyPromise = new Promise((resolve) => { ready = resolve; });
export const app = Object.assign(new EventEmitter(), {
  isPackaged: false,
  whenReady: () => readyPromise,
  setName() {}, requestSingleInstanceLock: () => true, quit() {}, focus() {},
  getVersion: () => "test",
  getPath: (name) => {
    const home = process.env.CODEX_PERSONAL_LAUNCHER_HOME_OVERRIDE;
    if (!home) throw Error("Test HOME override is required");
    if (name === "home") return home;
    if (name === "appData") return path.join(home, "Library", "Application Support");
    if (name === "userData") return path.join(home, "Library", "Application Support", "Codex Personal Launcher");
    throw Error(`Unexpected path: ${name}`);
  },
  isDefaultProtocolClient: () => false
});
export function becomeReady() { ready(); }
export class BrowserWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
    calls.windows.push(this);
  }
  static getAllWindows() { return calls.windows; }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  isMinimized() { return false; }
  isVisible() { return true; }
  isFocused() { return calls.focused; }
  restore() {} show() {} focus() { calls.focused = true; }
}
export const ipcMain = { handle: (name, callback) => calls.ipc.set(name, callback) };
export const dialog = { showErrorBox: (...args) => calls.dialogs.push(args), showMessageBox: async () => ({ response: 0 }) };
export const shell = { showItemInFolder() {} };
export class Notification {
  static isSupported() { return calls.notificationsSupported; }
  constructor(options) { this.options = options; }
  show() { if (calls.notificationFails) throw Error("Unavailable notifications"); calls.notifications.push(this.options); }
  on() { return this; }
}
