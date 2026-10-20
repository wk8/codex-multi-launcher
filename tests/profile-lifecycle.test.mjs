import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import * as service from "../dist-electron/main/profile-service.js";
import { assertIsolatedProfileStorage } from "../dist-electron/main/isolated-profile.js";
import { exists, policy, serviceFixture, waitFor } from "./helpers.mjs";

async function stopped(profileId) {
  return (await service.getRuntimeStatus()).find((item) => item.profileId === profileId)?.status === "not_running";
}

test("creation, startup and launch all apply policy before a fake desktop sees the profile", async (t) => {
  const f = await serviceFixture(t);
  await f.writePolicy();
  const created = await service.createProfile(f.input);
  assert.equal(created.preparation.status, "ready");
  assert.match(await fs.readFile(created.configPath, "utf8"), /followUpQueueMode = "queue"/);
  await fs.writeFile(created.configPath, '[desktop]\nfollowUpQueueMode="steer"\n');
  const startup = await service.refreshActiveProfileLaunchers();
  assert.equal(startup[0].status, "ready");
  assert.match(await fs.readFile(created.configPath, "utf8"), /"queue"/);
  await fs.writeFile(created.configPath, '[desktop]\nfollowUpQueueMode="steer"\n');
  await service.openProfile(created.profile.id);
  await waitFor(async () => await exists(f.capture) && (await fs.readFile(f.capture, "utf8")).includes("queue"), "prepared fake desktop launch");
  await waitFor(() => stopped(created.profile.id), "fake desktop exit");
  assert.equal((await service.getPreparationResults())[0].event, "launch");
});

test("one malformed existing profile does not prevent another profile being prepared", async (t) => {
  const f = await serviceFixture(t);
  const bad = await service.createProfile(f.input);
  const good = await service.createProfile({ ...f.input, name: "Good" });
  await f.writePolicy();
  await fs.writeFile(bad.configPath, "malformed = [");
  const startup = await service.refreshActiveProfileLaunchers();
  assert.equal(startup.find((item) => item.profileId === bad.profile.id).status, "blocked");
  assert.equal(startup.find((item) => item.profileId === good.profile.id).status, "ready");
  assert.match(await fs.readFile(good.configPath, "utf8"), /queue/);
  await assert.rejects(service.openProfile(bad.profile.id));
  assert.equal(await exists(f.capture), false);
  await fs.writeFile(bad.configPath, "# repaired\n");
  assert.equal((await service.retryProfilePreparation(bad.profile.id)).status, "ready");
});

test("failed creation preparation retains a visible profile and supports retry and deletion", async (t) => {
  const f = await serviceFixture(t);
  await fs.writeFile(f.policyFile, "malformed");
  const created = await service.createProfile(f.input);
  assert.equal(created.preparation.status, "blocked");
  assert.equal(created.preparation.setupPending, true);
  assert.equal((await service.listProfiles()).length, 1);
  assert.equal(await exists(created.launcherPath), true);
  await f.writePolicy(policy({ scope: "new-profiles" }));
  assert.equal((await service.retryProfilePreparation(created.profile.id)).status, "ready");
  await service.permanentlyDeleteProfile(created.profile.id);
  assert.deepEqual(await service.listProfiles(), []);
  assert.deepEqual(await service.getPreparationResults(), []);
});

test("concurrent Open requests launch once; a running profile defers defaults and rejects deletion", async (t) => {
  const f = await serviceFixture(t, 700);
  await f.writePolicy();
  const created = await service.createProfile(f.input);
  const opened = await Promise.all(Array.from({ length: 8 }, () => service.openProfile(created.profile.id)));
  assert.equal(new Set(opened.map((item) => item.pid)).size, 1);
  await waitFor(() => exists(f.capture), "fake launch capture");
  assert.equal((await fs.readFile(f.capture, "utf8")).match(/LAUNCH/g).length, 1);
  const before = await fs.readFile(created.configPath, "utf8");
  await f.writePolicy(policy({ config: [{ path: ["desktop", "followUpQueueMode"], value: "changed" }] }));
  assert.equal((await service.retryProfilePreparation(created.profile.id)).status, "deferred");
  assert.equal((await service.refreshActiveProfileLaunchers())[0].status, "deferred");
  assert.equal(await fs.readFile(created.configPath, "utf8"), before);
  await assert.rejects(service.permanentlyDeleteProfile(created.profile.id), /Close the profile/);
  await assert.rejects(service.generateProfileLauncher(created.profile.id), /Close the profile/);
  await waitFor(() => stopped(created.profile.id), "fake desktop exit");
  assert.equal((await service.retryProfilePreparation(created.profile.id)).status, "ready");
});

test("concurrent profile creation and launch metadata updates retain every registry record", async (t) => {
  const f = await serviceFixture(t);
  const created = await Promise.all(Array.from({ length: 3 }, () => service.createProfile(f.input)));
  assert.equal(new Set(created.map((item) => item.profile.id)).size, 3);
  assert.equal((await service.listProfiles()).length, 3);
  await Promise.all(created.map((item) => service.openProfile(item.profile.id)));
  const registry = await service.listProfiles();
  assert.ok(registry.every((item) => item.launch.lastLaunchedAt && item.launch.lastKnownPid));
  for (const item of created) await waitFor(() => stopped(item.profile.id), "fake desktop exit");
});

test("symlinked profile storage cannot redirect defaults into another home", async (t) => {
  const f = await serviceFixture(t);
  const created = await service.createProfile(f.input);
  const original = created.profile.paths.codexHome;
  const moved = path.join(f.root, "external-codex-home");
  await fs.rename(original, moved);
  await fs.symlink(moved, original);
  await assert.rejects(assertIsolatedProfileStorage(created.profile), /link/);
  await f.writePolicy();
  assert.equal((await service.retryProfilePreparation(created.profile.id)).status, "blocked");
  assert.doesNotMatch(await fs.readFile(path.join(moved, "config.toml"), "utf8"), /followUpQueueMode/);
});

test("a prior successful check never authorizes launching after policy or settings become invalid", async (t) => {
  const f = await serviceFixture(t);
  await f.writePolicy();
  const created = await service.createProfile(f.input);
  assert.equal(created.preparation.status, "ready");
  await fs.writeFile(path.join(created.profile.paths.codexHome, ".codex-global-state.json"), "invalid");
  await assert.rejects(service.openProfile(created.profile.id));
  assert.equal(await exists(f.capture), false);
  assert.equal((await service.getPreparationResults())[0].status, "blocked");
});
