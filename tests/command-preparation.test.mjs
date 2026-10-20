import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ProfilePreparation } from "../dist-electron/main/profile-preparation.js";
import { warningsAcknowledged } from "../dist-electron/shared/preparation-feedback.js";
import { commandResponse, exists, fixture, policy, waitFor, writeCommand } from "./helpers.mjs";

const warning = { severity: "warning", code: "LOCAL_CHECK", message: "Review the local instruction file.", details: "An optional check was skipped." };
const error = { severity: "error", code: "HEADER_MISMATCH", message: "Unexpected header; fix it before launching.", details: "First mismatch is line 3." };

test("a warning allows defaults while persisting command diagnostics and its invocation", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, `process.stderr.write("diagnostic only"); ${commandResponse([warning])}`);
  await f.writePolicy(policy({ prepareCommand: command }));
  const result = await f.coordinator.prepare(f.profile, "create");
  assert.equal(result.status, "warning");
  assert.deepEqual(result.messages, [warning]);
  assert.deepEqual(result.newWarningCodes, [warning.code]);
  assert.equal(result.command.stderr, "diagnostic only");
  assert.equal(result.command.cleanupPending, false);
  assert.match(result.invocationId, /^[0-9a-f-]{36}$/);
  assert.equal(result.changedFiles.length, 2);
  assert.equal(result.setupPending, false);
  assert.deepEqual(await f.coordinator.readResult(f.profile.id), result);
  assert.match(await fs.readFile(f.configFile, "utf8"), /queue/);
});

for (const [name, source] of [
  ["error at exit zero", commandResponse([error])],
  ["warning with nonzero exit", `${commandResponse([warning])} process.exitCode = 1;`],
  ["protocol failure", 'process.stdout.write("invalid JSON");'],
  ["mixed warning and error", commandResponse([warning, error])]
]) {
  test(`${name} blocks both built-in stores`, async (t) => {
    const f = await fixture(t);
    const command = await writeCommand(f, source);
    await f.writePolicy(policy({ prepareCommand: command }));
    await fs.writeFile(f.configFile, "# untouched\n");
    const result = await f.coordinator.prepare(f.profile, "create");
    assert.equal(result.status, "blocked");
    assert.equal(result.setupPending, true);
    assert.ok(result.messages.some((message) => message.severity === "error"));
    assert.equal(await fs.readFile(f.configFile, "utf8"), "# untouched\n");
    assert.equal(await exists(f.stateFile), false);
    assert.equal(await exists(path.join(f.dataDir, "profile-defaults-backups")), false);
  });
}

test("command-only policies run without reading or changing either settings store", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, commandResponse([{ severity: "info", code: "DONE", message: "Checked." }]));
  await f.writePolicy(policy({ config: [], desktopState: [], prepareCommand: command }));
  await fs.writeFile(f.configFile, "bad TOML deliberately untargeted");
  const result = await f.coordinator.prepare(f.profile, "launch");
  assert.equal(result.status, "ready");
  assert.deepEqual(result.changedFiles, []);
  assert.equal(await fs.readFile(f.configFile, "utf8"), "bad TOML deliberately untargeted");
  assert.equal(await exists(f.stateFile), false);
});

test("the command reads pre-default files; fresh plans preserve its successful changes", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, `
    const before = await fs.readFile(input.profile.paths.configFile, "utf8");
    if (!before.includes("steer")) throw Error("Defaults ran too early");
    await fs.appendFile(input.profile.paths.configFile, "command_added = 42\\n");
    await fs.writeFile(input.profile.paths.globalStateFile, JSON.stringify({ fromCommand: { keep: true } }));
    ${commandResponse()}
  `);
  await f.writePolicy(policy({ prepareCommand: command }));
  await fs.writeFile(f.configFile, '[desktop]\nfollowUpQueueMode = "steer"\n');
  const result = await f.coordinator.prepare(f.profile, "launch");
  assert.equal(result.status, "ready");
  const text = await fs.readFile(f.configFile, "utf8");
  assert.match(text, /"queue"/);
  assert.match(text, /command_added = 42/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile)), { fromCommand: { keep: true }, "electron-initial-follow-up-queue-mode": "queue" });
  assert.match(await fs.readFile(path.join(result.backupPath, "0.original"), "utf8"), /command_added = 42/);
});

test("fresh fill-missing plans respect a value introduced by the command", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, `await fs.writeFile(input.profile.paths.configFile, '[desktop]\\nfollowUpQueueMode="command-value"\\n'); ${commandResponse()}`);
  await f.writePolicy(policy({ mode: "fill-missing", prepareCommand: command }));
  assert.equal((await f.coordinator.prepare(f.profile, "create")).status, "ready");
  assert.match(await fs.readFile(f.configFile, "utf8"), /command-value/);
});

test("a failing command owns its own changes; the launcher does not roll them back", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, `await fs.writeFile(input.profile.paths.agentsFile, "command-owned change"); ${commandResponse([error])}`);
  await f.writePolicy(policy({ prepareCommand: command }));
  assert.equal((await f.coordinator.prepare(f.profile, "create")).status, "blocked");
  assert.equal(await fs.readFile(path.join(f.profile.paths.codexHome, "AGENTS.md"), "utf8"), "command-owned change");
  assert.equal(await exists(f.configFile), false);
});

test("invalid settings produced by a successful command block the fresh defaults plan", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, `await fs.writeFile(input.profile.paths.globalStateFile, "invalid"); ${commandResponse()}`);
  await f.writePolicy(policy({ prepareCommand: command }));
  const result = await f.coordinator.prepare(f.profile, "startup");
  assert.equal(result.status, "blocked");
  assert.match(result.messages.at(-1).message, /valid JSON/);
  assert.equal(await exists(f.configFile), false);
  assert.equal(await fs.readFile(f.stateFile, "utf8"), "invalid");
});

test("invalid initial plans block before invoking the command", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, "called");
  const command = await writeCommand(f, `await fs.writeFile(${JSON.stringify(marker)}, "called"); ${commandResponse()}`);
  await f.writePolicy(policy({ prepareCommand: command }));
  await fs.writeFile(f.stateFile, "invalid");
  assert.equal((await f.coordinator.prepare(f.profile, "startup")).status, "blocked");
  assert.equal(await exists(marker), false);
});

test("preview never executes the command and marks its effects as unchecked", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, "called");
  const command = await writeCommand(f, `await fs.writeFile(${JSON.stringify(marker)}, "called"); ${commandResponse()}`);
  await f.writePolicy(policy({ prepareCommand: command }));
  const preview = await f.coordinator.preview(f.profile);
  assert.equal(preview.status, "ready");
  assert.equal(preview.command.status, "not-run");
  assert.equal(preview.command.cwd, f.dataDir);
  assert.equal(preview.changes.length, 2);
  assert.ok(preview.messages.some((message) => message.code === "LAUNCHER_COMMAND_NOT_RUN"));
  assert.equal(await exists(marker), false);
  assert.equal(await f.coordinator.readResult(f.profile.id), null);
});

for (const runtime of ["running", "unknown"]) {
  test(`${runtime} profiles never invoke a command`, async (t) => {
    const f = await fixture(t);
    const marker = path.join(f.root, "called");
    const command = await writeCommand(f, `await fs.writeFile(${JSON.stringify(marker)}, "called"); ${commandResponse()}`);
    await f.writePolicy(policy({ prepareCommand: command }));
    f.setRuntime(runtime);
    assert.equal((await f.coordinator.prepare(f.profile, "launch")).status, "deferred");
    assert.equal(await exists(marker), false);
    assert.equal(await exists(f.configFile), false);
  });
}

test("command scope matches defaults, including pending creation and disabled policies", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, "events.jsonl");
  const command = await writeCommand(f, `await fs.appendFile(${JSON.stringify(marker)}, JSON.stringify({ event: input.event, id: input.invocationId }) + "\\n"); ${commandResponse()}`);
  await f.writePolicy(policy({ scope: "new-profiles", prepareCommand: command }));
  assert.equal((await f.coordinator.prepare(f.profile, "startup")).status, "disabled");
  assert.equal((await f.coordinator.prepare(f.profile, "launch")).status, "disabled");
  assert.equal(await exists(marker), false);
  assert.equal((await f.coordinator.prepare(f.profile, "create")).status, "ready");
  await f.writePolicy(policy({ prepareCommand: command }));
  await f.coordinator.prepare(f.profile, "startup");
  await f.coordinator.prepare(f.profile, "launch");
  const events = (await fs.readFile(marker, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((item) => item.event), ["create", "startup", "launch"]);
  assert.equal(new Set(events.map((item) => item.id)).size, 3);
  await f.writePolicy(policy({ enabled: false, prepareCommand: command }));
  assert.equal((await f.coordinator.prepare(f.profile, "launch")).status, "disabled");
  assert.equal((await fs.readFile(marker, "utf8")).trim().split("\n").length, 3);
});

test("identical warnings are deduplicated, acknowledgment preserves them, and a pass clears them", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, commandResponse([warning]));
  await f.writePolicy(policy({ prepareCommand: command }));
  const first = await f.coordinator.prepare(f.profile, "create");
  assert.deepEqual(first.newWarningCodes, [warning.code]);
  assert.deepEqual((await f.coordinator.prepare(f.profile, "startup")).newWarningCodes, []);
  const acknowledged = await f.coordinator.acknowledgeWarnings(f.profile.id);
  assert.equal(acknowledged.status, "warning");
  assert.deepEqual(acknowledged.messages, [warning]);
  assert.equal(warningsAcknowledged(acknowledged), true);
  assert.equal(warningsAcknowledged(await f.coordinator.prepare(f.profile, "launch")), true);
  await writeCommand(f, commandResponse([{ ...warning, details: "A different line now needs attention." }]));
  const changed = await f.coordinator.prepare(f.profile, "launch");
  assert.deepEqual(changed.newWarningCodes, [warning.code]);
  assert.equal(warningsAcknowledged(changed), false);
  await writeCommand(f, commandResponse());
  const passed = await f.coordinator.prepare(f.profile, "launch");
  assert.equal(passed.status, "ready");
  assert.deepEqual(passed.messages, []);
  assert.deepEqual(passed.acknowledgedWarnings, []);
});

test("deferral retains prior command warnings until a command actually checks them again", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, commandResponse([warning]));
  await f.writePolicy(policy({ prepareCommand: command }));
  await f.coordinator.prepare(f.profile, "create");
  f.setRuntime("running");
  const pending = await f.coordinator.prepare(f.profile, "launch");
  assert.equal(pending.status, "deferred");
  assert.ok(pending.messages.some((message) => message.code === warning.code));
  assert.ok(!pending.newWarningCodes.includes(warning.code));
});

test("a failed check preserves unresolved warnings from the preceding result", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, commandResponse([warning]));
  await f.writePolicy(policy({ prepareCommand: command }));
  await f.coordinator.prepare(f.profile, "create");
  await writeCommand(f, commandResponse([error]));
  const result = await f.coordinator.prepare(f.profile, "launch");
  assert.equal(result.status, "blocked");
  assert.ok(result.messages.some((message) => message.code === warning.code));
  assert.ok(!result.newWarningCodes.includes(warning.code));
});

test("a command changing the policy cannot cause stale defaults to be applied", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, `await fs.writeFile(input.launcher.policyFile, "{}"); ${commandResponse()}`);
  await f.writePolicy(policy({ prepareCommand: command }));
  const result = await f.coordinator.prepare(f.profile, "launch");
  assert.equal(result.status, "blocked");
  assert.match(result.messages.at(-1).message, /changed since preparation/);
  assert.equal(await exists(f.configFile), false);
});

test("persisted command ownership blocks a second coordinator while a command can still write", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, `await new Promise(resolve => setTimeout(resolve, 400)); ${commandResponse()}`);
  await f.writePolicy(policy({ prepareCommand: command }));
  const first = f.coordinator.prepare(f.profile, "create");
  await waitFor(async () => (await f.coordinator.readResult(f.profile.id))?.command?.cleanupPending, "durable command ownership");
  const restarted = new ProfilePreparation(f.host);
  await assert.rejects(restarted.assertNoActiveCommand(f.profile.id), /active processes/);
  const concurrent = await restarted.prepare(f.profile, "launch");
  assert.equal(concurrent.status, "blocked");
  assert.equal(concurrent.command.cleanupPending, true);
  assert.equal(await exists(f.configFile), false);
  assert.equal((await first).status, "ready");
  await assert.doesNotReject(restarted.assertNoActiveCommand(f.profile.id));
});

test("an unreadable ownership record stays intact and cannot be bypassed by repeated retries", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, commandResponse([error]));
  await f.writePolicy(policy({ scope: "new-profiles", prepareCommand: command }));
  assert.equal((await f.coordinator.prepare(f.profile, "create")).status, "blocked");
  const directory = path.join(f.dataDir, "profile-preparation");
  const record = path.join(directory, (await fs.readdir(directory))[0]);
  await fs.writeFile(record, "corrupt ownership record");
  for (let i = 0; i < 3; i++) {
    const result = await f.coordinator.prepare(f.profile, "launch");
    assert.equal(result.status, "blocked");
    assert.ok(result.messages[0].message.includes(record));
    assert.equal(await fs.readFile(record, "utf8"), "corrupt ownership record");
  }
  assert.equal(await exists(f.configFile), false);
});
