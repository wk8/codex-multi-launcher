import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";
import * as service from "../dist-electron/main/profile-service.js";
import { exists, policy, serviceFixture, waitFor, writeCommand } from "./helpers.mjs";

test("startup batches notices, background launch surfaces warnings once, and errors block shortcuts", async (t) => {
  const f = await serviceFixture(t, 100);
  const first = await service.createProfile(f.input);
  await service.createProfile({ ...f.input, name: "Second" });
  const condition = path.join(f.root, "condition.json");
  await fs.writeFile(condition, JSON.stringify({ severity: "warning", extra: "" }));
  const command = await writeCommand(f, `
    const condition = JSON.parse(await fs.readFile(${JSON.stringify(condition)}, "utf8"));
    process.stdout.write(JSON.stringify({ protocolVersion: 1, messages: [{
      severity: condition.severity, code: "LOCAL_CHECK", message: input.event + ": check " + condition.extra
    }] }));
  `);
  await f.writePolicy(policy({ prepareCommand: command }));
  const mockUrl = new URL("./fixtures/electron.mjs", import.meta.url).href;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === "electron" ? { url: mockUrl, shortCircuit: true } : next(specifier, context);
  } });
  t.after(() => hooks.deregister());
  const mock = await import(mockUrl);
  mock.calls.focused = false;
  await import("../dist-electron/main/index.js");
  mock.becomeReady();
  await waitFor(() => mock.calls.notifications.length === 1, "one startup batch notification");
  assert.match(mock.calls.notifications[0].body, /2 with warnings/);
  assert.equal((await service.getPreparationResults()).filter((result) => result.status === "warning").length, 2);

  mock.app.emit("second-instance", {}, ["launcher", `--open-profile=${first.profile.id}`]);
  await waitFor(() => mock.calls.notifications.length === 2, "background launch warning");
  await waitFor(() => exists(f.capture), "background fake app");
  await waitFor(async () => (await service.getRuntimeStatus()).every((result) => result.status === "not_running"), "fake app exit");
  assert.match(mock.calls.notifications[1].title, /Setup warning/);
  const open = mock.calls.ipc.get("profiles:open");
  const repeated = await open({}, first.profile.id);
  assert.deepEqual(repeated.preparation.newWarningCodes, []);
  assert.equal(mock.calls.notifications.length, 2);
  await waitFor(async () => (await service.getRuntimeStatus()).every((result) => result.status === "not_running"), "repeated fake app exit");

  const acknowledge = mock.calls.ipc.get("profiles:acknowledge-warnings");
  assert.deepEqual((await acknowledge({}, first.profile.id)).acknowledgedWarnings, ["LOCAL_CHECK"]);
  mock.calls.notificationsSupported = false;
  mock.calls.focused = false;
  await fs.writeFile(condition, JSON.stringify({ severity: "warning", extra: "changed" }));
  const retry = await mock.calls.ipc.get("profiles:retry-preparation")({}, first.profile.id);
  assert.equal(retry.status, "warning");
  assert.deepEqual(retry.newWarningCodes, ["LOCAL_CHECK"]);
  assert.equal(mock.calls.notifications.length, 2);
  assert.ok((await service.getPreparationResults()).find((item) => item.profileId === first.profile.id).messages[0].message.includes("changed"));

  mock.calls.notificationsSupported = true;
  mock.calls.notificationFails = true;
  await fs.writeFile(condition, JSON.stringify({ severity: "warning", extra: "changed again" }));
  assert.equal((await mock.calls.ipc.get("profiles:retry-preparation")({}, first.profile.id)).status, "warning");
  const capturesBefore = await fs.readFile(f.capture, "utf8");
  await fs.writeFile(condition, JSON.stringify({ severity: "error", extra: "blocked" }));
  mock.app.emit("second-instance", {}, ["launcher", `--open-profile=${first.profile.id}`]);
  await waitFor(() => mock.calls.dialogs.length > 0, "explicit shortcut failure");
  assert.match(mock.calls.dialogs.at(-1)[1], /blocked/);
  assert.equal(await fs.readFile(f.capture, "utf8"), capturesBefore);
});
