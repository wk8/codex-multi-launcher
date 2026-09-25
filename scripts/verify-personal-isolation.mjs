import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-isolation-"));
const home = path.join(testRoot, "home");
const fakeApp = path.join(testRoot, "ChatGPT.app");
const fakeExecutable = path.join(fakeApp, "Contents", "MacOS", "ChatGPT");
const launchCapture = path.join(testRoot, "launch-environment.txt");
const workSentinel = "WORK-SENTINEL-MUST-NOT-COPY";
const originalHome = process.env.HOME;

try {
  await fs.mkdir(path.dirname(fakeExecutable), { recursive: true });
  await fs.writeFile(
    fakeExecutable,
    [
      "#!/bin/sh",
      "{",
      "  printenv | sort",
      "  printf 'ARGS:'",
      "  for argument in \"$@\"; do printf ' <%s>' \"$argument\"; done",
      "  printf '\\n'",
      "} > \"$PERSONAL_LAUNCH_TEST_CAPTURE\"",
      ""
    ].join("\n"),
    { mode: 0o700 }
  );

  const defaultCodexHome = path.join(home, ".codex");
  const workSkillPath = path.join(home, ".agents", "skills", "work-only", "SKILL.md");
  await fs.mkdir(path.join(defaultCodexHome, "sessions"), { recursive: true });
  await fs.mkdir(path.join(defaultCodexHome, "plugins", "work-only"), { recursive: true });
  await fs.mkdir(path.dirname(workSkillPath), { recursive: true });
  await fs.writeFile(path.join(defaultCodexHome, "AGENTS.md"), workSentinel);
  await fs.writeFile(path.join(defaultCodexHome, "config.toml"), `work_secret = "${workSentinel}"\n`);
  await fs.writeFile(path.join(defaultCodexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: workSentinel }));
  await fs.writeFile(path.join(defaultCodexHome, "sessions", "work.jsonl"), workSentinel);
  await fs.writeFile(path.join(defaultCodexHome, "plugins", "work-only", "plugin.json"), workSentinel);
  await fs.writeFile(workSkillPath, workSentinel);

  process.env.CODEX_PERSONAL_LAUNCHER_HOME_OVERRIDE = home;
  process.env.HOME = home;
  process.env.OPENAI_API_KEY = workSentinel;
  process.env.CODEX_HOME = defaultCodexHome;
  process.env.CODEX_WORK_SECRET = workSentinel;
  process.env.CHATGPT_WORK_SECRET = workSentinel;
  process.env.ELECTRON_WORK_SECRET = workSentinel;
  process.env.PERSONAL_LAUNCH_TEST_CAPTURE = launchCapture;

  const service = await import("../dist-electron/main/profile-service.js");

  await assert.rejects(
    service.createProfile({
      name: "Legacy unsafe input",
      codexAppPath: fakeApp,
      inheritDefaultConfig: true
    }),
    /Unsupported personal-profile fields/
  );

  const first = await service.createProfile({
    name: "Personal",
    codexAppPath: fakeApp,
    appearance: { iconBackgroundColor: "#007AFF" }
  });
  const second = await service.createProfile({
    name: "Personal",
    codexAppPath: fakeApp
  });

  assert.equal(first.profile.auth.mode, "chatgpt_account");
  assert.equal(second.profile.auth.mode, "chatgpt_account");
  assert.notEqual(first.profile.id, second.profile.id);
  assert.notEqual(first.profile.paths.homeDir, second.profile.paths.homeDir);
  assert.notEqual(first.profile.paths.codexHome, second.profile.paths.codexHome);
  assert.notEqual(first.profile.paths.userDataDir, second.profile.paths.userDataDir);
  assert.match(first.profile.paths.codexHome, /\.codex-personal-profiles/);
  assert.match(first.profile.paths.userDataDir, /Codex Personal Profiles/);

  const personalUserSkills = path.join(first.profile.paths.homeDir, ".agents", "skills");
  const personalCodexSkills = path.join(first.profile.paths.codexHome, "skills");
  assert.notEqual(first.profile.paths.homeDir, home);
  assert.equal(first.profile.paths.codexHome, path.join(first.profile.paths.homeDir, "codex-home"));
  assert.deepEqual(await fs.readdir(personalUserSkills), []);
  assert.deepEqual(await fs.readdir(personalCodexSkills), []);
  assert.equal(await exists(path.join(personalUserSkills, "work-only", "SKILL.md")), false);

  const config = await fs.readFile(first.configPath, "utf8");
  const launcher = await fs.readFile(
    path.join(first.launcherPath, "Contents", "MacOS", "launcher"),
    "utf8"
  );
  assert.doesNotMatch(config, new RegExp(workSentinel));
  assert.match(config, /No settings, history, plugins, skills, MCP configuration, or credentials were inherited/);
  assert.match(launcher, /--user-data-dir="\$USER_DATA_DIR"/);
  assert.match(launcher, /"\$HOME" != "\$CODEX_PERSONAL_HOME"/);
  assert.match(launcher, /CODEX_HOME/);
  assert.equal(await exists(path.join(first.profile.paths.codexHome, "auth.json")), false);
  assert.equal(await exists(path.join(first.profile.paths.codexHome, "AGENTS.md")), false);
  assert.equal(await exists(path.join(first.profile.paths.codexHome, "sessions")), false);
  assert.equal(await exists(path.join(first.profile.paths.codexHome, "plugins")), false);

  await service.openProfile(first.profile.id);
  await waitForFile(launchCapture);
  const capturedLaunch = await fs.readFile(launchCapture, "utf8");
  assert.match(capturedLaunch, new RegExp(`^HOME=${escapeRegExp(first.profile.paths.homeDir)}$`, "m"));
  assert.match(capturedLaunch, new RegExp(`^CODEX_HOME=${escapeRegExp(first.profile.paths.codexHome)}$`, "m"));
  assert.match(capturedLaunch, new RegExp(`^CODEX_PERSONAL_HOME=${escapeRegExp(first.profile.paths.homeDir)}$`, "m"));
  assert.match(capturedLaunch, new RegExp(`^XDG_CONFIG_HOME=${escapeRegExp(path.join(first.profile.paths.homeDir, ".config"))}$`, "m"));
  assert.match(capturedLaunch, new RegExp(`USER_DATA_DIR=${escapeRegExp(first.profile.paths.userDataDir)}`));
  assert.match(capturedLaunch, new RegExp(`ARGS: <--user-data-dir=${escapeRegExp(first.profile.paths.userDataDir)}>`));
  assert.doesNotMatch(capturedLaunch, /OPENAI_API_KEY=/);
  assert.doesNotMatch(capturedLaunch, /CODEX_WORK_SECRET=/);
  assert.doesNotMatch(capturedLaunch, /CHATGPT_WORK_SECRET=/);
  assert.doesNotMatch(capturedLaunch, /ELECTRON_WORK_SECRET=/);
  assert.doesNotMatch(capturedLaunch, new RegExp(workSentinel));

  const emittedMainFiles = await fs.readdir(path.resolve("dist-electron/main"));
  for (const forbiddenModule of [
    "codex-config.js",
    "diagnostics.js",
    "provider-test.js",
    "secrets.js",
    "subscription-auth.js",
    "windows-appx-cache.js",
    "windows-window-icon.js"
  ]) {
    assert.equal(emittedMainFiles.includes(forbiddenModule), false, `${forbiddenModule} must not be packaged`);
  }

  const emittedSources = await Promise.all(
    emittedMainFiles.filter((file) => file.endsWith(".js"))
      .map((file) => fs.readFile(path.resolve("dist-electron/main", file), "utf8"))
  );
  const emittedText = emittedSources.join("\n");
  assert.doesNotMatch(emittedText, /sub2api|minai|electron-updater|releases\/latest|announcements\.json/);
  assert.doesNotMatch(emittedText, /\bfetch\s*\(/);

  await service.permanentlyDeleteProfile(first.profile.id);
  await service.permanentlyDeleteProfile(second.profile.id);
  assert.equal(await exists(first.profile.paths.homeDir), false);
  assert.equal(await exists(first.profile.paths.userDataDir), false);
  assert.equal(await exists(first.profile.paths.launcherPath), false);
  assert.equal(await fs.readFile(path.join(defaultCodexHome, "AGENTS.md"), "utf8"), workSentinel);
  assert.equal(await fs.readFile(path.join(defaultCodexHome, "auth.json"), "utf8"), JSON.stringify({ OPENAI_API_KEY: workSentinel }));
  assert.equal(await fs.readFile(workSkillPath, "utf8"), workSentinel);

  console.log("Personal profile isolation verification passed.");
} finally {
  delete process.env.CODEX_PERSONAL_LAUNCHER_HOME_OVERRIDE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_WORK_SECRET;
  delete process.env.CHATGPT_WORK_SECRET;
  delete process.env.ELECTRON_WORK_SECRET;
  delete process.env.PERSONAL_LAUNCH_TEST_CAPTURE;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(testRoot, { force: true, recursive: true });
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(targetPath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fs.readFile(targetPath, "utf8")).includes("ARGS:")) return;
    } catch {
      // The detached test process has not created the capture yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${targetPath}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
