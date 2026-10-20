import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const appPath = path.join(projectRoot, "dist-app/mac-arm64/Codex Personal Launcher.app");
const archivePath = path.join(appPath, "Contents/Resources/app.asar");

if (process.versions.electron) {
  await verifyProfileCreation();
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-packaged-profile-"));
  const home = path.join(root, "home");
  const cache = path.join(root, "cache");

  try {
    await Promise.all([fs.mkdir(home), fs.mkdir(cache)]);
    const { stdout } = await promisify(execFile)(
      path.join(appPath, "Contents/MacOS/Codex Personal Launcher"),
      [scriptPath],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: cache,
          ELECTRON_RUN_AS_NODE: "1",
          CODEX_PERSONAL_LAUNCHER_HOME_OVERRIDE: home
        },
        timeout: 30_000
      }
    );
    process.stdout.write(stdout);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function verifyProfileCreation() {
  const home = process.env.CODEX_PERSONAL_LAUNCHER_HOME_OVERRIDE;
  const cache = process.env.TMPDIR;
  assert.ok(home && cache, "Run this verification through Node to isolate its files.");

  const bundledIconPath = path.join(archivePath, "assets/app.icns");
  const expectedIcon = await fs.readFile(bundledIconPath);

  // Electron caches an extracted filename for copyFile even after temp cleanup.
  // On macOS its native extraction directory can ignore TMPDIR. Inspect the
  // cached archive rather than guessing which directory holds the temporary file.
  await fs.copyFile(bundledIconPath, path.join(home, "warmup.icns"));
  const archive = process._getOrCreateArchive(archivePath);
  assert.equal(archive.getFileInfo("assets/app.icns").unpacked, false, "The fixture must exercise ASAR extraction.");
  const extractedIcon = archive.copyFileOut("assets/app.icns");
  assert.ok(path.isAbsolute(extractedIcon) && !extractedIcon.startsWith(`${appPath}${path.sep}`));
  assert.equal((await fs.lstat(extractedIcon)).isFile(), true);
  assert.deepEqual(await fs.readFile(extractedIcon), expectedIcon);
  await fs.rm(extractedIcon);
  await assert.rejects(fs.copyFile(bundledIconPath, path.join(home, "stale-cache.icns")), { code: "ENOENT" });

  const service = await import(pathToFileURL(path.join(archivePath, "dist-electron/main/profile-service.js")).href);
  const fakeApp = path.join(home, "ChatGPT.app");
  const executable = path.join(fakeApp, "Contents/MacOS/ChatGPT");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

  const { getAppPaths } = await import(pathToFileURL(path.join(archivePath, "dist-electron/main/paths.js")).href);
  const dataDir = getAppPaths().appDataDir;
  await fs.mkdir(dataDir, { recursive: true });
  const eventsFile = path.join(home, "command-events.jsonl");
  const commandScript = path.join(home, "prepare-profile.mjs");
  await fs.writeFile(commandScript, `
    import fs from "node:fs/promises";
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const input = JSON.parse(text);
    await fs.appendFile(${JSON.stringify(eventsFile)}, JSON.stringify(input) + "\\n");
    process.stdout.write(JSON.stringify({ protocolVersion: 1, messages: [
      { severity: "warning", code: "PACKAGED_CHECK", message: "Packaged command completed." }
    ] }));
  `);
  await fs.writeFile(path.join(dataDir, "profile-defaults.json"), JSON.stringify({
    schemaVersion: 1, enabled: true, scope: "all-managed-profiles", mode: "enforce",
    config: [{ path: ["desktop", "followUpQueueMode"], value: "queue" }],
    desktopState: [{ path: ["electron-persisted-atom-state", "markdownCodeBlockWordWrap"], value: true }],
    prepareCommand: { executable: process.execPath, args: [commandScript], timeoutMs: 5000 }
  }));

  const created = [];
  for (const name of ["First personal", "Second personal"]) {
    const result = await service.createProfile({ name, codexAppPath: fakeApp });
    const iconPath = path.join(result.launcherPath, "Contents/Resources/profile-icon.icns");
    assert.deepEqual(await fs.readFile(iconPath), expectedIcon);
    assert.equal((await fs.stat(iconPath)).mode & 0o777, 0o600);
    assert.equal(result.preparation.status, "warning", JSON.stringify(result.preparation.messages));
    assert.match(await fs.readFile(result.configPath, "utf8"), /followUpQueueMode = "queue"/);
    const state = JSON.parse(await fs.readFile(path.join(result.profile.paths.codexHome, ".codex-global-state.json")));
    assert.equal(state["electron-persisted-atom-state"].markdownCodeBlockWordWrap, true);
    created.push(result.profile.id);
  }
  assert.deepEqual((await service.listProfiles()).map((profile) => profile.id).sort(), created.sort());
  const preview = await service.previewProfileDefaults(created[0]);
  assert.equal(preview.command.status, "not-run");
  assert.equal((await fs.readFile(eventsFile, "utf8")).trim().split("\n").length, 2);
  assert.ok((await service.refreshActiveProfileLaunchers()).every((result) => result.status === "warning"));
  assert.equal((await service.openProfile(created[0])).preparation.status, "warning");
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await service.getRuntimeStatus()).every((result) => result.status === "not_running")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok((await service.getRuntimeStatus()).every((result) => result.status === "not_running"));
  const events = (await fs.readFile(eventsFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.event).sort(), ["create", "create", "launch", "startup", "startup"]);
  assert.ok(events.every((event) => path.isAbsolute(event.profile.paths.configFile) && event.launcher.dataDir === dataDir));
  console.log("Packaged creation, defaults, command hooks, preview, startup, and launch passed after Electron temporary icon cleanup.");
}
