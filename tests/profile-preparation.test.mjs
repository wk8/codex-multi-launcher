import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ProfilePreparation } from "../dist-electron/main/profile-preparation.js";
import { fixture, exists, policy } from "./helpers.mjs";

test("absent and disabled policies preserve existing profile bytes and produce no profile artifacts", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.configFile, "invalid TOML untouched");
  assert.equal((await f.coordinator.prepare(f.profile, "create")).status, "disabled");
  await f.writePolicy(policy({ enabled: false }));
  assert.equal((await f.coordinator.prepare(f.profile, "launch")).status, "disabled");
  assert.equal(await fs.readFile(f.configFile, "utf8"), "invalid TOML untouched");
  assert.equal(await exists(f.stateFile), false);
  assert.equal(await exists(path.join(f.dataDir, "profile-defaults-backups")), false);
});

test("create applies defaults to both stores, preserving unrelated content", async (t) => {
  const f = await fixture(t);
  await f.writePolicy();
  await fs.writeFile(f.configFile, "# keep this comment\n[features]\nkeep = true\n");
  await fs.writeFile(f.stateFile, '{"keep":{"unknown":true}}');
  const result = await f.coordinator.prepare(f.profile, "create");
  assert.equal(result.status, "ready");
  assert.equal(result.changedFiles.length, 2);
  assert.ok(result.backupPath);
  assert.match(await fs.readFile(f.configFile, "utf8"), /# keep this comment/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile)), { keep: { unknown: true }, "electron-initial-follow-up-queue-mode": "queue" });
  assert.deepEqual(await f.coordinator.readResult(f.profile.id), result);
});

test("enforce re-applies on startup and launch; fill-missing respects existing preferences", async (t) => {
  const f = await fixture(t);
  await f.writePolicy();
  for (const event of ["startup", "launch"]) {
    await fs.writeFile(f.configFile, '[desktop]\nfollowUpQueueMode="steer"\n');
    assert.equal((await f.coordinator.prepare(f.profile, event)).status, "ready");
    assert.match(await fs.readFile(f.configFile, "utf8"), /"queue"/);
  }
  await f.writePolicy(policy({ mode: "fill-missing" }));
  await fs.writeFile(f.configFile, '[desktop]\nfollowUpQueueMode="steer"\n');
  assert.equal((await f.coordinator.prepare(f.profile, "launch")).changedFiles.length, 0);
  assert.match(await fs.readFile(f.configFile, "utf8"), /"steer"/);
});

test("new-profiles scope skips existing profiles but retries incomplete creation", async (t) => {
  const f = await fixture(t);
  await f.writePolicy(policy({ scope: "new-profiles" }));
  assert.equal((await f.coordinator.prepare(f.profile, "startup")).status, "disabled");
  assert.equal((await f.coordinator.prepare(f.profile, "launch")).status, "disabled");
  assert.equal(await exists(f.configFile), false);
  await fs.writeFile(f.stateFile, "malformed");
  const blocked = await f.coordinator.prepare(f.profile, "create");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.setupPending, true);
  assert.equal(await exists(f.configFile), false);
  await fs.unlink(f.stateFile);
  assert.equal((await f.coordinator.prepare(f.profile, "launch")).status, "ready");
  assert.equal((await f.coordinator.readResult(f.profile.id)).setupPending, false);
  await fs.writeFile(f.configFile, '[desktop]\nfollowUpQueueMode="steer"\n');
  assert.equal((await f.coordinator.prepare(f.profile, "startup")).status, "disabled");
  assert.match(await fs.readFile(f.configFile, "utf8"), /steer/);
});

for (const runtime of ["running", "unknown"]) {
  test(`${runtime} runtime defers every profile write`, async (t) => {
    const f = await fixture(t);
    await f.writePolicy();
    f.setRuntime(runtime);
    for (const event of ["create", "startup", "launch"]) {
      const result = await f.coordinator.prepare(f.profile, event);
      assert.equal(result.status, "deferred");
      assert.equal(result.messages[0].code, "LAUNCHER_PROFILE_NOT_STOPPED");
    }
    assert.deepEqual(await fs.readdir(f.profile.paths.codexHome), []);
    assert.equal(await exists(path.join(f.dataDir, "profile-defaults-backups")), false);
  });
}

test("malformed state or TOML validates both plans before either file is changed", async (t) => {
  const f = await fixture(t);
  await f.writePolicy();
  await fs.writeFile(f.configFile, "# untouched\n");
  await fs.writeFile(f.stateFile, "{bad");
  assert.equal((await f.coordinator.prepare(f.profile, "launch")).status, "blocked");
  assert.equal(await fs.readFile(f.configFile, "utf8"), "# untouched\n");
  assert.equal(await exists(path.join(f.dataDir, "profile-defaults-backups")), false);
  await fs.writeFile(f.stateFile, "{}");
  await fs.writeFile(f.configFile, "a = [");
  assert.equal((await f.coordinator.prepare(f.profile, "startup")).status, "blocked");
  assert.equal(await fs.readFile(f.stateFile, "utf8"), "{}");
});

test("preview plans exact paths and values without changing profile, backups or result records", async (t) => {
  const f = await fixture(t);
  await f.writePolicy();
  const preview = await f.coordinator.preview(f.profile);
  assert.equal(preview.status, "ready");
  assert.equal(preview.changes.length, 2);
  assert.equal(preview.changes[0].before, null);
  assert.equal(preview.changes[0].after, '"queue"');
  assert.deepEqual(await fs.readdir(f.profile.paths.codexHome), []);
  assert.deepEqual(await fs.readdir(f.dataDir), ["profile-defaults.json"]);
  f.setRuntime("running");
  assert.equal((await f.coordinator.preview(f.profile)).status, "deferred");
  assert.equal(await f.coordinator.readResult(f.profile.id), null);
});

test("no-op retries do not rewrite files or create more backups; policy removal stops enforcement", async (t) => {
  const f = await fixture(t);
  await f.writePolicy();
  const first = await f.coordinator.prepare(f.profile, "create");
  const before = await fs.stat(f.configFile);
  const retry = await f.coordinator.prepare(f.profile, "launch");
  assert.deepEqual(retry.changedFiles, []);
  assert.equal(retry.backupPath, undefined);
  assert.equal((await fs.stat(f.configFile)).ino, before.ino);
  assert.equal((await fs.readdir(path.dirname(first.backupPath))).length, 1);
  await fs.unlink(f.coordinator.policyFile);
  await fs.writeFile(f.configFile, "# custom\n");
  assert.equal((await f.coordinator.prepare(f.profile, "startup")).status, "disabled");
  assert.equal(await fs.readFile(f.configFile, "utf8"), "# custom\n");
});

test("runtime transitions and policy edits during preparation block stale writes", async (t) => {
  const f = await fixture(t);
  await f.writePolicy();
  let checks = 0;
  const coordinator = new ProfilePreparation({ ...f.host, inspect: async () => {
    if (++checks === 3) f.setRuntime("running");
    return f.host.inspect(f.profile);
  } });
  assert.equal((await coordinator.prepare(f.profile, "launch")).status, "blocked");
  assert.equal(await exists(f.configFile), false);
  f.setRuntime("not_running");
  checks = 0;
  const editing = new ProfilePreparation({ ...f.host, inspect: async () => {
    if (++checks === 3) await f.writePolicy(policy({ mode: "fill-missing" }));
    return f.host.inspect(f.profile);
  } });
  const result = await editing.prepare(f.profile, "launch");
  assert.equal(result.status, "blocked");
  assert.match(result.messages[0].message, /changed since/);
  assert.equal(await exists(f.configFile), false);
});

test("untargeted desktop state is never parsed or touched", async (t) => {
  const f = await fixture(t);
  await f.writePolicy(policy({ desktopState: [] }));
  await fs.writeFile(f.stateFile, "invalid but untouched");
  assert.equal((await f.coordinator.prepare(f.profile, "startup")).status, "ready");
  assert.equal(await fs.readFile(f.stateFile, "utf8"), "invalid but untouched");
});

test("unsafe storage, symlinked files and invalid policies block with explicit feedback", async (t) => {
  const f = await fixture(t);
  await f.writePolicy();
  const blocked = new ProfilePreparation({ ...f.host, assertStorage: async () => { throw Error("unsafe profile storage"); } });
  assert.match((await blocked.prepare(f.profile, "launch")).messages[0].message, /unsafe profile storage/);
  await fs.writeFile(path.join(f.root, "external"), "# unchanged\n");
  await fs.symlink(path.join(f.root, "external"), f.configFile);
  assert.equal((await f.coordinator.prepare(f.profile, "launch")).status, "blocked");
  assert.equal(await fs.readFile(path.join(f.root, "external"), "utf8"), "# unchanged\n");
  await fs.writeFile(f.coordinator.policyFile, "malformed");
  assert.equal((await f.coordinator.preview(f.profile)).status, "blocked");
});
