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
  const existingFiles = new Set(await fs.readdir(cache));
  await fs.copyFile(bundledIconPath, path.join(home, "warmup.icns"));
  const extractedFiles = (await fs.readdir(cache)).filter((file) => !existingFiles.has(file));
  assert.ok(extractedFiles.length > 0, "The fixture must exercise ASAR extraction.");
  await Promise.all(extractedFiles.map((file) => fs.rm(path.join(cache, file), { recursive: true })));

  const service = await import(pathToFileURL(path.join(archivePath, "dist-electron/main/profile-service.js")).href);
  const fakeApp = path.join(home, "ChatGPT.app");
  const executable = path.join(fakeApp, "Contents/MacOS/ChatGPT");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

  const created = [];
  for (const name of ["First personal", "Second personal"]) {
    const result = await service.createProfile({ name, codexAppPath: fakeApp });
    const iconPath = path.join(result.launcherPath, "Contents/Resources/profile-icon.icns");
    assert.deepEqual(await fs.readFile(iconPath), expectedIcon);
    assert.equal((await fs.stat(iconPath)).mode & 0o777, 0o600);
    created.push(result.profile.id);
  }
  assert.deepEqual((await service.listProfiles()).map((profile) => profile.id).sort(), created.sort());
  console.log("Packaged profile creation passed after Electron temporary icon cleanup.");
}
