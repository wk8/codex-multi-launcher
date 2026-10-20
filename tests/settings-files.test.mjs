import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  applyFileChanges, assertUnchanged, atomicWriteText, pendingTransactions, readSettingsFile, recoverFileChanges
} from "../dist-electron/main/settings-files.js";
import { exists, fixture } from "./helpers.mjs";

async function plan(f, first = "one", second = "two") {
  await fs.writeFile(f.configFile, first, { mode: 0o640 });
  if (second !== null) await fs.writeFile(f.stateFile, second);
  return [
    { before: await readSettingsFile(f.configFile), after: "new one" },
    { before: await readSettingsFile(f.stateFile), after: "new two" }
  ];
}
const noop = async () => undefined;

test("transaction backs up originals, preserves permissions and atomically replaces both files", async (t) => {
  const f = await fixture(t);
  const changes = await plan(f);
  const backup = await applyFileChanges(changes, path.join(f.root, "backups"), noop);
  assert.equal(await fs.readFile(f.configFile, "utf8"), "new one");
  assert.equal(await fs.readFile(f.stateFile, "utf8"), "new two");
  assert.equal((await fs.stat(f.configFile)).mode & 0o777, 0o640);
  assert.equal(await fs.readFile(path.join(backup, "0.original"), "utf8"), "one");
  assert.equal(await fs.readFile(path.join(backup, "1.original"), "utf8"), "two");
  assert.equal((await fs.stat(path.join(backup, "0.original"))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(path.join(backup, "transaction.json"))).state, "committed");
  assert.deepEqual(await pendingTransactions(path.dirname(backup), changes.map((file) => file.before.path)), []);
  assert.deepEqual((await fs.readdir(path.dirname(f.configFile))).sort(), [".codex-global-state.json", "config.toml"]);
});

test("a compliant plan does not write or create backups", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.configFile, "same");
  const before = await readSettingsFile(f.configFile);
  const backups = path.join(f.root, "backups");
  assert.equal(await applyFileChanges([{ before, after: "same" }], backups, () => { throw Error("must not run"); }), undefined);
  await assertUnchanged([before]);
  assert.equal(await exists(backups), false);
});

test("stale plans and permission-only changes never overwrite an external edit", async (t) => {
  const f = await fixture(t);
  const changes = await plan(f);
  await fs.writeFile(f.stateFile, "external");
  await assert.rejects(applyFileChanges(changes, path.join(f.root, "backups"), noop), /changed since preparation/);
  assert.equal(await fs.readFile(f.configFile, "utf8"), "one");
  const current = await readSettingsFile(f.configFile);
  await fs.chmod(f.configFile, 0o600);
  await assert.rejects(assertUnchanged([current]), /changed/);
  assert.equal(await exists(path.join(f.root, "backups")), false);
});

test("a second-file failure restores the first and retains reviewable backups", async (t) => {
  const f = await fixture(t);
  const changes = await plan(f);
  const io = {
    replace: async (file, value, mode) => {
      if (file === f.stateFile && value === "new two") throw Error("simulated disk full");
      await atomicWriteText(file, value, mode);
    }, remove: fs.unlink
  };
  await assert.rejects(applyFileChanges(changes, path.join(f.root, "backups"), noop, io), /originals restored.*disk full/);
  assert.equal(await fs.readFile(f.configFile, "utf8"), "one");
  assert.equal(await fs.readFile(f.stateFile, "utf8"), "two");
  assert.deepEqual(await pendingTransactions(path.join(f.root, "backups"), [f.configFile, f.stateFile]), []);
});

test("rollback removes a newly created file and restores absence", async (t) => {
  const f = await fixture(t);
  const changes = await plan(f, "one", null);
  changes.reverse();
  let replacements = 0;
  const io = {
    replace: async (...args) => { if (++replacements === 2) throw Error("second write fails"); await atomicWriteText(...args); },
    remove: fs.unlink
  };
  await assert.rejects(applyFileChanges(changes, path.join(f.root, "backups"), noop, io), /originals restored/);
  assert.equal(await exists(f.stateFile), false);
  assert.equal(await fs.readFile(f.configFile, "utf8"), "one");
});

test("interrupted rollback leaves a recoverable journal for the next preparation", async (t) => {
  const f = await fixture(t);
  const changes = await plan(f);
  let calls = 0;
  const io = {
    replace: async (...args) => { if (++calls > 1) throw Error("unavailable storage"); await atomicWriteText(...args); },
    remove: fs.unlink
  };
  const backups = path.join(f.root, "backups");
  await assert.rejects(applyFileChanges(changes, backups, noop, io), /recovery needs attention/);
  assert.equal((await pendingTransactions(backups, [f.configFile, f.stateFile])).length, 1);
  await recoverFileChanges(backups, [f.configFile, f.stateFile], noop);
  assert.equal(await fs.readFile(f.configFile, "utf8"), "one");
  assert.equal(await fs.readFile(f.stateFile, "utf8"), "two");
  assert.equal((await pendingTransactions(backups, [f.configFile, f.stateFile])).length, 0);
});

test("recovery refuses modified originals and untrusted journal paths", async (t) => {
  const f = await fixture(t);
  const changes = await plan(f);
  const backups = path.join(f.root, "backups");
  let calls = 0;
  await assert.rejects(applyFileChanges(changes, backups, noop, {
    replace: async (...args) => { if (++calls > 1) throw Error("failure"); await atomicWriteText(...args); }, remove: fs.unlink
  }));
  await fs.writeFile(f.configFile, "external edit");
  await assert.rejects(recoverFileChanges(backups, [f.configFile, f.stateFile], noop), /external edit/);
  assert.equal(await fs.readFile(f.configFile, "utf8"), "external edit");
  const [{ directory }] = await pendingTransactions(backups, [f.configFile, f.stateFile]);
  const journalFile = path.join(directory, "transaction.json");
  const journal = JSON.parse(await fs.readFile(journalFile));
  journal.entries[0].path = path.join(f.root, "outside");
  await fs.writeFile(journalFile, JSON.stringify(journal));
  await assert.rejects(pendingTransactions(backups, [f.configFile, f.stateFile]), /Invalid.*journal/);
});

test("runtime safety checks also guard recovery and leave a pending journal", async (t) => {
  const f = await fixture(t);
  const changes = await plan(f);
  let writes = 0;
  const io = {
    replace: async (...args) => { if (++writes > 1) throw Error("stopped being safe"); await atomicWriteText(...args); }, remove: fs.unlink
  };
  const backups = path.join(f.root, "backups");
  await assert.rejects(applyFileChanges(changes, backups, noop, io, async () => { throw Error("profile is running"); }), /recovery needs attention/);
  assert.equal(await fs.readFile(f.configFile, "utf8"), "new one");
  await assert.rejects(recoverFileChanges(backups, [f.configFile, f.stateFile], async () => { throw Error("running"); }), /running/);
  assert.equal(await fs.readFile(f.configFile, "utf8"), "new one");
  await recoverFileChanges(backups, [f.configFile, f.stateFile], noop);
});

test("safe reads distinguish absent files from invalid UTF-8, links, directories and oversize files", async (t) => {
  const f = await fixture(t);
  assert.equal((await readSettingsFile(f.configFile)).text, null);
  await fs.writeFile(f.configFile, Buffer.from([0xff]));
  await assert.rejects(readSettingsFile(f.configFile), /encoded data/);
  await fs.writeFile(f.configFile, "1234");
  await assert.rejects(readSettingsFile(f.configFile, 3), /exceeds/);
  await fs.symlink(f.configFile, f.stateFile);
  await assert.rejects(readSettingsFile(f.stateFile), /regular file/);
  await assert.rejects(readSettingsFile(f.dataDir), /regular file/);
});

test("an unrelated file changing midway through apply triggers rollback", async (t) => {
  const f = await fixture(t);
  const changes = await plan(f);
  const io = {
    replace: async (file, text, mode) => {
      await atomicWriteText(file, text, mode);
      if (file === f.configFile && text === "new one") await fs.writeFile(f.stateFile, "external edit");
    }, remove: fs.unlink
  };
  await assert.rejects(applyFileChanges(changes, path.join(f.root, "backups"), noop, io), /recovery needs attention/);
  assert.equal(await fs.readFile(f.stateFile, "utf8"), "external edit");
});
