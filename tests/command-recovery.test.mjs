import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ProfilePreparation } from "../dist-electron/main/profile-preparation.js";
import { commandGroupExists } from "../dist-electron/main/preparation-command.js";
import { commandResponse, exists, fixture, policy, waitFor, writeCommand } from "./helpers.mjs";

test("a crashed manager leaves durable ownership that blocks surviving command writers", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, "command-started");
  const command = await writeCommand(f, `await fs.writeFile(${JSON.stringify(marker)}, "started"); setInterval(() => {}, 1000);`, { timeoutMs: 10000 });
  await f.writePolicy(policy({ prepareCommand: command }));
  const managerScript = path.join(f.root, "temporary-manager.mjs");
  await fs.writeFile(managerScript, `
    import { ProfilePreparation } from ${JSON.stringify(new URL("../dist-electron/main/profile-preparation.js", import.meta.url).href)};
    const profile = ${JSON.stringify(f.profile)};
    const coordinator = new ProfilePreparation({
      dataDir: ${JSON.stringify(f.dataDir)}, userHomeDir: ${JSON.stringify(f.host.userHomeDir)},
      commandProfile: () => (${JSON.stringify(f.host.commandProfile(f.profile))}),
      inspect: async () => ({ profileId: profile.id, status: "not_running", pid: null, detail: "Fixture" }),
      assertStorage: async () => {}
    });
    await coordinator.prepare(profile, "create");
  `);
  const manager = spawn(process.execPath, [managerScript], { stdio: "ignore" });
  const managerExited = new Promise((resolve) => manager.once("exit", resolve));
  let groupId;
  try {
    await waitFor(() => exists(marker), "command receiving its profile input");
    const checkpoint = await f.coordinator.readResult(f.profile.id);
    groupId = checkpoint.command.processGroupId;
    assert.equal(checkpoint.setupPending, true);
    assert.equal(checkpoint.command.cleanupPending, true);
    manager.kill("SIGKILL");
    await managerExited;
    assert.equal(commandGroupExists(groupId), true);

    const restarted = new ProfilePreparation(f.host);
    assert.equal((await restarted.preview(f.profile)).status, "blocked");
    const blocked = await restarted.prepare(f.profile, "startup");
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.messages[0].message, /active processes/);
    assert.equal(await exists(f.configFile), false);
    await f.writePolicy(policy({ enabled: false, prepareCommand: command }));
    assert.equal((await restarted.prepare(f.profile, "launch")).status, "blocked");

    process.kill(-groupId, "SIGKILL");
    await waitFor(() => !commandGroupExists(groupId), "surviving group termination");
    const repaired = await writeCommand(f, commandResponse());
    await f.writePolicy(policy({ scope: "new-profiles", prepareCommand: repaired }));
    assert.equal((await restarted.prepare(f.profile, "launch")).status, "ready");
    assert.match(await fs.readFile(f.configFile, "utf8"), /queue/);
  } finally {
    if (manager.exitCode === null && manager.signalCode === null) manager.kill("SIGKILL");
    await managerExited;
    groupId ??= (await f.coordinator.readResult(f.profile.id))?.command?.processGroupId;
    if (commandGroupExists(groupId)) process.kill(-groupId, "SIGKILL");
    await waitFor(() => !commandGroupExists(groupId), "fixture cleanup");
  }
});
