import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import * as service from "../dist-electron/main/profile-service.js";
import { exists, serviceFixture, waitFor } from "./helpers.mjs";

test("cold-start shortcuts and second-instance opens wait for the startup sweep and coalesce", async (t) => {
  const f = await serviceFixture(t, 200);
  const created = await service.createProfile(f.input);
  await f.writePolicy();
  const mockUrl = new URL("./fixtures/electron.mjs", import.meta.url).href;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === "electron" ? { url: mockUrl, shortCircuit: true } : next(specifier, context);
  } });
  t.after(() => hooks.deregister());
  const mock = await import(mockUrl);
  const oldArgv = process.argv;
  process.argv = [...oldArgv, `--open-profile=${created.profile.id}`];
  t.after(() => { process.argv = oldArgv; });
  await import("../dist-electron/main/index.js");
  mock.app.emit("second-instance", {}, ["launcher", `--open-profile=${created.profile.id}`]);
  assert.equal(await exists(f.capture), false);
  mock.becomeReady();
  await waitFor(async () => await exists(f.capture) && (await fs.readFile(f.capture, "utf8")).includes("queue"), "cold-start launch after defaults");
  await waitFor(async () => (await service.getRuntimeStatus())[0].status === "not_running", "fake desktop exit");
  assert.equal((await fs.readFile(f.capture, "utf8")).match(/LAUNCH/g).length, 1);
  assert.equal((await service.getPreparationResults())[0].event, "launch");
  assert.deepEqual(mock.calls.dialogs, []);
  assert.equal(mock.calls.windows.length, 1);
  assert.ok(mock.calls.ipc.has("profiles:preview-defaults"));

  await fs.writeFile(created.configPath, "invalid = [");
  mock.app.emit("second-instance", {}, ["launcher", `--open-profile=${created.profile.id}`]);
  await waitFor(() => mock.calls.dialogs.length > 0, "blocked shortcut feedback");
  assert.equal(mock.calls.dialogs[0][0], "Personal Profile Launch Failed");
  assert.equal((await fs.readFile(f.capture, "utf8")).match(/LAUNCH/g).length, 1);
});
