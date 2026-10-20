import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import * as service from "../dist-electron/main/profile-service.js";
import { commandResponse, exists, policy, serviceFixture, waitFor, writeCommand } from "./helpers.mjs";

const warning = { severity: "warning", code: "CUSTOM_WARNING", message: "Optional setup needs attention." };
const error = { severity: "error", code: "HEADER_MISMATCH", message: "AGENTS.md has an unexpected header." };
const stopped = async (id) => (await service.getRuntimeStatus()).find((item) => item.profileId === id)?.status === "not_running";

test("hook failure retains creation; retries use create context and do not silently bypass a new-profile policy", async (t) => {
  const f = await serviceFixture(t);
  const capture = path.join(f.root, "input.json");
  const command = await writeCommand(f, `await fs.writeFile(${JSON.stringify(capture)}, JSON.stringify(input)); ${commandResponse([error])}`);
  await f.writePolicy(policy({ scope: "new-profiles", prepareCommand: command }));
  const created = await service.createProfile(f.input);
  assert.equal(created.preparation.status, "blocked");
  assert.equal(created.preparation.setupPending, true);
  const firstInput = JSON.parse(await fs.readFile(capture));
  assert.equal(firstInput.event, "create");
  assert.equal(firstInput.profile.id, created.profile.id);
  assert.equal(firstInput.profile.paths.configFile, created.configPath);
  assert.equal(firstInput.profile.paths.desktopAppPath, created.profile.paths.codexAppPath);
  assert.equal(firstInput.profile.paths.desktopExecutablePath, f.executable);
  assert.equal(firstInput.launcher.dataDir, f.appPaths.appDataDir);
  assert.equal(firstInput.launcher.policyFile, f.policyFile);
  assert.notEqual(firstInput.launcher.userHomeDir, firstInput.profile.paths.homeDir);
  await assert.rejects(service.openProfile(created.profile.id), /unexpected header/);
  assert.equal(await exists(f.capture), false);
  assert.equal((await service.listProfiles()).length, 1);
  await writeCommand(f, `await fs.writeFile(${JSON.stringify(capture)}, JSON.stringify(input)); ${commandResponse()}`);
  assert.equal((await service.retryProfilePreparation(created.profile.id)).status, "ready");
  assert.equal(JSON.parse(await fs.readFile(capture)).event, "create");
  assert.match(await fs.readFile(created.configPath, "utf8"), /queue/);
  await service.permanentlyDeleteProfile(created.profile.id);
});

test("warnings allow launch and simultaneous Open requests run only one launch hook", async (t) => {
  const f = await serviceFixture(t, 250);
  const eventsFile = path.join(f.root, "events.jsonl");
  const command = await writeCommand(f, `await fs.appendFile(${JSON.stringify(eventsFile)}, input.event + "\\n"); ${commandResponse([warning])}`);
  await f.writePolicy(policy({ prepareCommand: command }));
  const created = await service.createProfile(f.input);
  assert.equal(created.preparation.status, "warning");
  const opened = await Promise.all(Array.from({ length: 6 }, () => service.openProfile(created.profile.id)));
  assert.ok(opened.every((result) => result.preparation.status === "warning"));
  assert.equal(new Set(opened.map((result) => result.pid)).size, 1);
  assert.deepEqual((await fs.readFile(eventsFile, "utf8")).trim().split("\n"), ["create", "launch"]);
  await waitFor(() => exists(f.capture), "warning launch");
  assert.equal((await fs.readFile(f.capture, "utf8")).match(/LAUNCH/g).length, 1);
  const prior = await fs.readFile(eventsFile, "utf8");
  assert.equal((await service.retryProfilePreparation(created.profile.id)).status, "deferred");
  assert.equal(await fs.readFile(eventsFile, "utf8"), prior);
  await waitFor(() => stopped(created.profile.id), "fake app exit");
  const ack = await service.acknowledgeProfileWarnings(created.profile.id);
  assert.ok(ack.acknowledgedWarnings.includes(warning.code));
});

test("startup hook errors isolate one profile while another profile completes setup", async (t) => {
  const f = await serviceFixture(t);
  const first = await service.createProfile({ ...f.input, name: "Blocked" });
  const second = await service.createProfile({ ...f.input, name: "Allowed" });
  const command = await writeCommand(f, `process.stdout.write(JSON.stringify({ protocolVersion: 1, messages: input.profile.name === "Blocked" ? [${JSON.stringify(error)}] : [] }));`);
  await f.writePolicy(policy({ prepareCommand: command }));
  const results = await service.refreshActiveProfileLaunchers();
  assert.equal(results.find((item) => item.profileId === first.profile.id).status, "blocked");
  assert.equal(results.find((item) => item.profileId === second.profile.id).status, "ready");
  assert.doesNotMatch(await fs.readFile(first.configPath, "utf8"), /followUpQueueMode/);
  assert.match(await fs.readFile(second.configPath, "utf8"), /followUpQueueMode/);
});

test("timeout blocks launch and a repaired command can be retried without a lingering writer", async (t) => {
  const f = await serviceFixture(t);
  const created = await service.createProfile(f.input);
  const command = await writeCommand(f, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);', { timeoutMs: 200 });
  await f.writePolicy(policy({ prepareCommand: command }));
  await assert.rejects(service.openProfile(created.profile.id), /timeout/);
  assert.equal(await exists(f.capture), false);
  const blocked = (await service.getPreparationResults())[0];
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.command.cleanupPending, false);
  await writeCommand(f, commandResponse());
  assert.equal((await service.retryProfilePreparation(created.profile.id)).status, "ready");
});
