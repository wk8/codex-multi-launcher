import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildCommandInput, commandGroupExists, parseCommandResponse, resolveCommand, runPreparationCommand,
  COMMAND_STDERR_LIMIT, COMMAND_STDOUT_LIMIT
} from "../dist-electron/main/preparation-command.js";
import { parseDefaultsPolicy } from "../dist-electron/main/defaults-policy.js";
import { commandResponse, exists, fixture, policy, writeCommand } from "./helpers.mjs";

const warning = { severity: "warning", code: "HEADER_CHECK", message: "Header needs attention.", details: "Line 3 differs." };
const failure = { severity: "error", code: "HEADER_MISMATCH", message: "Unexpected instruction header." };

function inputFor(f) {
  return buildCommandInput(f.host.commandProfile(f.profile), "launch", "test-invocation", {
    userHomeDir: f.host.userHomeDir, dataDir: f.dataDir, policyFile: f.coordinator.policyFile
  }, f.dataDir);
}

test("command policy supplies explicit argv and timeout defaults", () => {
  const parsed = parseDefaultsPolicy(JSON.stringify(policy({ prepareCommand: { executable: "python3" } })));
  assert.deepEqual(parsed.prepareCommand, { executable: "python3", args: [], timeoutMs: 30000 });
});

for (const [name, prepareCommand] of [
  ["a shell string", "echo hi"], ["null", null], ["empty executable", { executable: " " }],
  ["NUL executable", { executable: "a\0b" }], ["string argv", { executable: "x", args: "-c command" }],
  ["non-string argument", { executable: "x", args: [42] }], ["NUL argument", { executable: "x", args: ["a\0b"] }],
  ["empty cwd", { executable: "x", cwd: "" }], ["zero timeout", { executable: "x", timeoutMs: 0 }],
  ["fractional timeout", { executable: "x", timeoutMs: 100.5 }], ["unbounded timeout", { executable: "x", timeoutMs: 300001 }],
  ["shell option", { executable: "x", shell: true }], ["unknown environment field", { executable: "x", env: {} }]
]) {
  test(`command policy rejects ${name}`, () => assert.throws(() => parseDefaultsPolicy(JSON.stringify(policy({ prepareCommand })))));
}

test("relative executable and cwd are resolved against the policy directory; argv stays literal", () => {
  const value = { executable: "./hooks/check", args: ["$HOME", "~/file", "*.md"], cwd: "./work", timeoutMs: 1000 };
  assert.deepEqual(resolveCommand(value, "/data/launcher/profile-defaults.json"), {
    ...value, executable: "/data/launcher/hooks/check", cwd: "/data/launcher/work"
  });
  assert.equal(resolveCommand({ executable: "python3", args: [], timeoutMs: 1000 }, "/data/policy.json").executable, "python3");
});

test("command input is a whitelisted snapshot with absolute paths and no credentials or file contents", async (t) => {
  const f = await fixture(t);
  const profile = { ...f.host.commandProfile(f.profile), token: "SECRET", auth: { key: "SECRET" } };
  profile.paths.unknown = "SECRET";
  profile.appearance.extra = "SECRET";
  const launcher = { userHomeDir: f.host.userHomeDir, dataDir: f.dataDir, policyFile: f.coordinator.policyFile, token: "SECRET" };
  const input = buildCommandInput(profile, "create", "unique", launcher, f.dataDir);
  assert.equal(input.protocolVersion, 1);
  assert.equal(input.event, "create");
  assert.equal(input.invocationId, "unique");
  assert.equal(input.platform, process.platform);
  assert.equal(input.profile.authMode, "chatgpt_account");
  assert.equal(input.profile.homeIsolated, true);
  assert.equal(input.profile.paths.configFile, f.configFile);
  assert.equal(input.profile.paths.globalStateFile, f.stateFile);
  assert.equal(input.profile.paths.agentsFile, path.join(f.profile.paths.codexHome, "AGENTS.md"));
  assert.equal(Object.keys(input.profile.paths).length, 9);
  assert.ok(Object.values(input.profile.paths).every(path.isAbsolute));
  assert.doesNotMatch(JSON.stringify(input), /SECRET|auth\.json|fileContents/);
  assert.equal(await exists(input.profile.paths.agentsFile), false);

  profile.homeIsolated = false;
  profile.paths.homeDir = launcher.userHomeDir;
  assert.equal(buildCommandInput(profile, "startup", "another", launcher, f.dataDir).profile.homeIsolated, false);
  profile.paths.homeDir = "relative";
  assert.throws(() => buildCommandInput(profile, "startup", "another", launcher, f.dataDir), /absolute/);
});

test("response accepts empty success and mixed severities without a redundant fatal flag", () => {
  assert.deepEqual(parseCommandResponse('{"protocolVersion":1,"messages":[]}'), []);
  const messages = [{ severity: "info", code: "CHECKED", message: "Checked." }, warning, failure];
  assert.deepEqual(parseCommandResponse(JSON.stringify({ protocolVersion: 1, messages })), messages);
});

for (const [name, text] of [
  ["empty output", ""], ["multiple objects", '{}\n{}'], ["leading log", 'log\n{"protocolVersion":1,"messages":[]}'],
  ["unknown version", '{"protocolVersion":2,"messages":[]}'], ["missing messages", '{"protocolVersion":1}'],
  ["duplicate fields", '{"protocolVersion":2,"protocolVersion":1,"messages":[]}'],
  ["trailing comma", '{"protocolVersion":1,"messages":[],}'],
  ["fatal field", '{"protocolVersion":1,"messages":[],"fatal":false}'],
  ["unknown severity", JSON.stringify({ protocolVersion: 1, messages: [{ ...warning, severity: "fatal" }] })],
  ["empty message", JSON.stringify({ protocolVersion: 1, messages: [{ ...warning, message: "" }] })],
  ["reserved code", JSON.stringify({ protocolVersion: 1, messages: [{ ...warning, code: "LAUNCHER_TIMEOUT" }] })],
  ["duplicate codes", JSON.stringify({ protocolVersion: 1, messages: [warning, warning] })],
  ["object details", JSON.stringify({ protocolVersion: 1, messages: [{ ...warning, details: {} }] })],
  ["too many messages", JSON.stringify({ protocolVersion: 1, messages: Array.from({ length: 101 }, (_, i) => ({ ...warning, code: `W${i}` })) })]
]) {
  test(`response rejects ${name}`, () => assert.throws(() => parseCommandResponse(text)));
}

test("runner delivers one JSON input and EOF, literal arguments, and the selected cwd", async (t) => {
  const f = await fixture(t);
  const capture = path.join(f.root, "capture.json");
  const marker = path.join(f.root, "should-not-exist");
  const args = ["plain", "two words", `$(touch ${marker})`, `; touch ${marker}`, "`echo x`", "$HOME", "*.md", "--flag", "", "line\nbreak"];
  const command = await writeCommand(f, `await fs.writeFile(${JSON.stringify(capture)}, JSON.stringify({ input, args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME })); ${commandResponse()}`);
  command.args.push(...args);
  const result = await runPreparationCommand(resolveCommand(command, f.coordinator.policyFile), inputFor(f));
  assert.deepEqual(result.messages, []);
  assert.equal(result.diagnostics.exitCode, 0);
  const captured = JSON.parse(await fs.readFile(capture));
  assert.deepEqual(captured.input, inputFor(f));
  assert.deepEqual(captured.args, args);
  assert.equal(await fs.realpath(captured.cwd), await fs.realpath(f.dataDir));
  assert.equal(captured.home, process.env.HOME);
  assert.notEqual(captured.home, f.profile.paths.homeDir);
  assert.equal(await exists(marker), false);
});

test("command input is withheld until durable ownership is recorded", async (t) => {
  const f = await fixture(t);
  const capture = path.join(f.root, "received-input");
  const command = await writeCommand(f, `await fs.writeFile(${JSON.stringify(capture)}, "received"); ${commandResponse()}`);
  let recorded = false;
  const result = await runPreparationCommand(resolveCommand(command, f.coordinator.policyFile), inputFor(f), async (pid) => {
    assert.ok(commandGroupExists(pid));
    await delay(50);
    assert.equal(await exists(capture), false);
    recorded = true;
  });
  assert.equal(recorded, true);
  assert.deepEqual(result.messages, []);
  assert.equal(await exists(capture), true);
});

test("failed ownership persistence terminates the command without delivering profile input", async (t) => {
  const f = await fixture(t);
  const capture = path.join(f.root, "received-input");
  const command = await writeCommand(f, `await fs.writeFile(${JSON.stringify(capture)}, "received"); ${commandResponse()}`);
  const result = await runPreparationCommand(resolveCommand(command, f.coordinator.policyFile), inputFor(f), async () => { throw Error("disk failure"); });
  assert.ok(result.messages.some((message) => message.code === "LAUNCHER_COMMAND_RECORD_FAILED"));
  assert.equal(result.diagnostics.cleanupPending, false);
  assert.equal(await exists(capture), false);
});

test("stderr is bounded diagnostic text and does not turn a successful response into a warning", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, `process.stderr.write("x".repeat(${COMMAND_STDERR_LIMIT * 3}) + "TAIL"); ${commandResponse()}`);
  const result = await runPreparationCommand(resolveCommand(command, f.coordinator.policyFile), inputFor(f));
  assert.deepEqual(result.messages, []);
  assert.equal(result.diagnostics.stderr.length, COMMAND_STDERR_LIMIT);
  assert.equal(result.diagnostics.stderrTruncated, true);
  assert.ok(result.diagnostics.stderr.endsWith("TAIL"));
});

test("a valid response at the stdout byte limit is accepted", async (t) => {
  const f = await fixture(t);
  const messages = [
    { severity: "info", code: "A", message: "First", details: "x".repeat(32768) },
    { severity: "info", code: "B", message: "Second", details: "" }
  ];
  const remaining = COMMAND_STDOUT_LIMIT - Buffer.byteLength(JSON.stringify({ protocolVersion: 1, messages }));
  messages[1].details = "y".repeat(remaining);
  assert.ok(remaining <= 32768);
  assert.equal(Buffer.byteLength(JSON.stringify({ protocolVersion: 1, messages })), COMMAND_STDOUT_LIMIT);
  const command = await writeCommand(f, commandResponse(messages));
  const result = await runPreparationCommand(resolveCommand(command, f.coordinator.policyFile), inputFor(f));
  assert.deepEqual(result.messages, messages);
  assert.equal(result.diagnostics.exitCode, 0);
});

for (const [name, source, code] of [
  ["malformed stdout", 'process.stdout.write("log\\n{}");', "LAUNCHER_COMMAND_PROTOCOL"],
  ["invalid UTF-8", 'process.stdout.write(Buffer.from([0xff]));', "LAUNCHER_COMMAND_PROTOCOL"],
  ["stdout limit", `process.stdout.write("x".repeat(${COMMAND_STDOUT_LIMIT + 1}));`, "LAUNCHER_COMMAND_OUTPUT_LIMIT"],
  ["nonzero exit with warning", `${commandResponse([warning])} process.exitCode = 7;`, "LAUNCHER_COMMAND_EXIT"],
  ["signal termination", 'process.kill(process.pid, "SIGTERM");', "LAUNCHER_COMMAND_EXIT"]
]) {
  test(`runner blocks ${name}`, async (t) => {
    const f = await fixture(t);
    const command = await writeCommand(f, source);
    const result = await runPreparationCommand(resolveCommand(command, f.coordinator.policyFile), inputFor(f));
    assert.ok(result.messages.some((message) => message.severity === "error" && message.code === code));
    assert.equal(result.diagnostics.cleanupPending, false);
  });
}

test("an error response blocks even when the command exits zero", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, commandResponse([failure]));
  const result = await runPreparationCommand(resolveCommand(command, f.coordinator.policyFile), inputFor(f));
  assert.deepEqual(result.messages, [failure]);
  assert.equal(result.diagnostics.exitCode, 0);
});

test("the documented example command follows the same protocol", async (t) => {
  const f = await fixture(t);
  const command = {
    executable: process.execPath, args: [new URL("../examples/profile-prepare.mjs", import.meta.url).pathname],
    cwd: f.dataDir, timeoutMs: 5000
  };
  const missing = await runPreparationCommand(command, inputFor(f));
  assert.ok(missing.messages.some((message) => message.severity === "error" && message.code === "CONFIG_CHECK_FAILED"));
  await fs.writeFile(f.configFile, "# Example\n");
  const present = await runPreparationCommand(command, inputFor(f));
  assert.equal(present.diagnostics.exitCode, 0);
  assert.equal(present.messages[0].code, "CONFIG_ACCESSIBLE");
});

test("missing executable and invalid working directory produce actionable start errors", async (t) => {
  const f = await fixture(t);
  for (const command of [
    { executable: path.join(f.root, "missing"), args: [], cwd: f.dataDir, timeoutMs: 1000 },
    { executable: process.execPath, args: [], cwd: path.join(f.root, "missing"), timeoutMs: 1000 }
  ]) {
    const result = await runPreparationCommand(command, inputFor(f));
    assert.ok(result.messages.some((message) => message.code === "LAUNCHER_COMMAND_START_FAILED"));
    assert.equal(result.diagnostics.cleanupPending, false);
  }
});

test("timeout escalates to SIGKILL and waits until the command process group is gone", async (t) => {
  const f = await fixture(t);
  const command = await writeCommand(f, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);', { timeoutMs: 200 });
  const result = await runPreparationCommand(resolveCommand(command, f.coordinator.policyFile), inputFor(f));
  assert.ok(result.messages.some((message) => message.code === "LAUNCHER_COMMAND_TIMEOUT"));
  assert.equal(result.diagnostics.signal, "SIGKILL");
  assert.equal(result.diagnostics.cleanupPending, false);
  assert.equal(commandGroupExists(result.diagnostics.processGroupId), false);
  assert.ok(result.diagnostics.durationMs < 3000);
});

for (const earlyExit of [false, true]) {
  test(`${earlyExit ? "early parent exit" : "timeout"} also terminates descendant writers`, async (t) => {
    const f = await fixture(t);
    const writes = path.join(f.root, "descendant-writes");
    const childSource = `const fs = require("node:fs"); process.on("SIGTERM", () => {}); setInterval(() => fs.appendFileSync(${JSON.stringify(writes)}, "x"), 10);`;
    const command = await writeCommand(f, `
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" });
      ${earlyExit ? `child.unref(); await new Promise(resolve => setTimeout(resolve, 100)); ${commandResponse()}` : 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'}
    `, { timeoutMs: 500 });
    const result = await runPreparationCommand(resolveCommand(command, f.coordinator.policyFile), inputFor(f));
    assert.ok(result.messages.some((message) => message.code === (earlyExit ? "LAUNCHER_COMMAND_CHILDREN_RUNNING" : "LAUNCHER_COMMAND_TIMEOUT")));
    assert.equal(result.diagnostics.cleanupPending, false);
    const stopped = await fs.readFile(writes, "utf8");
    assert.ok(stopped.length > 0);
    await delay(100);
    assert.equal(await fs.readFile(writes, "utf8"), stopped);
    assert.equal(commandGroupExists(result.diagnostics.processGroupId), false);
  });
}
