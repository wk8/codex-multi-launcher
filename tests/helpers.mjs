import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProfilePreparation } from "../dist-electron/main/profile-preparation.js";

export const policy = (overrides = {}) => ({
  schemaVersion: 1, enabled: true, scope: "all-managed-profiles", mode: "enforce",
  config: [{ path: ["desktop", "followUpQueueMode"], value: "queue" }],
  desktopState: [{ path: ["electron-initial-follow-up-queue-mode"], value: "queue" }],
  ...overrides
});

export async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "launcher-defaults-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "launcher");
  const homeDir = path.join(root, "profile");
  const codexHome = path.join(homeDir, "codex-home");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  const profile = {
    id: "personal", name: "Personal", status: "active", auth: { mode: "chatgpt_account" },
    appearance: { iconBackgroundColor: "#007AFF" },
    paths: { homeDir, codexHome, userDataDir: path.join(root, "user-data"), launcherPath: path.join(root, "Personal.app"), codexAppPath: path.join(root, "ChatGPT.app") },
    launch: { lastLaunchedAt: null, lastKnownPid: null, lastKnownUserDataDir: path.join(root, "user-data") },
    timestamps: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  };
  let runtime = "not_running";
  const host = {
    dataDir,
    inspect: async () => ({ profileId: profile.id, status: runtime, pid: runtime === "running" ? 123 : null, detail: "Test runtime" }),
    assertStorage: async () => undefined
  };
  const coordinator = new ProfilePreparation(host);
  const configFile = path.join(codexHome, "config.toml");
  const stateFile = path.join(codexHome, ".codex-global-state.json");
  return {
    root, dataDir, profile, host, coordinator, configFile, stateFile,
    setRuntime: (next) => { runtime = next; },
    writePolicy: (value = policy()) => fs.writeFile(coordinator.policyFile, JSON.stringify(value))
  };
}

export async function exists(file) {
  try { await fs.access(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function waitFor(action, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await action()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}

export async function serviceFixture(t, holdMs = 0) {
  const f = await fixture(t);
  const previous = process.env.CODEX_PERSONAL_LAUNCHER_HOME_OVERRIDE;
  process.env.CODEX_PERSONAL_LAUNCHER_HOME_OVERRIDE = path.join(f.root, "user home");
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_PERSONAL_LAUNCHER_HOME_OVERRIDE;
    else process.env.CODEX_PERSONAL_LAUNCHER_HOME_OVERRIDE = previous;
  });
  const executable = path.join(f.profile.paths.codexAppPath, "Contents", "MacOS", "ChatGPT");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  const capture = path.join(f.root, "launch.txt");
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await fs.writeFile(executable, [
    "#!/bin/sh", `printf 'LAUNCH\\n' >> ${quote(capture)}`,
    `cat "$CODEX_HOME/config.toml" >> ${quote(capture)}`,
    `sleep ${holdMs / 1000}`, ""
  ].join("\n"), { mode: 0o700 });
  const { getAppPaths } = await import("../dist-electron/main/paths.js");
  const appPaths = getAppPaths();
  await fs.mkdir(appPaths.appDataDir, { recursive: true });
  return {
    ...f, appPaths, executable, capture,
    policyFile: path.join(appPaths.appDataDir, "profile-defaults.json"),
    writePolicy: (value = policy()) => fs.writeFile(path.join(appPaths.appDataDir, "profile-defaults.json"), JSON.stringify(value)),
    input: { name: "Test personal", codexAppPath: f.profile.paths.codexAppPath }
  };
}
