import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { sendCodexLinkToTarget } from "../dist-electron/main/deep-links.js";

if (process.platform !== "darwin") throw new Error("This verification requires macOS.");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-browser-links-"));
const children = [];
const fixture = path.join(root, "receiver.cjs");

try {
  await fs.writeFile(fixture, `
const { app } = require("electron");
const fs = require("node:fs");
const output = process.env.BROWSER_LINK_TEST_OUTPUT;
app.setPath("userData", process.env.BROWSER_LINK_TEST_USER_DATA);
app.on("open-url", (event, url) => {
  event.preventDefault();
  fs.appendFileSync(output + ".links", JSON.stringify(url) + "\\n");
});
app.whenReady().then(() => fs.writeFileSync(output + ".ready", JSON.stringify({ pid: process.pid, executablePath: process.execPath })));
`);
  const receivers = [];
  for (const label of ["main", "personal"]) {
    const output = path.join(root, label);
    const userData = path.join(root, `${label}-data`);
    await fs.mkdir(userData);
    const env = { ...process.env, BROWSER_LINK_TEST_OUTPUT: output, BROWSER_LINK_TEST_USER_DATA: userData };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [fixture], { env, stdio: "ignore" });
    children.push(child);
    child.on("error", () => {});
    const ready = await waitForJson(`${output}.ready`);
    receivers.push({ ...ready, output, name: label, profileId: label === "main" ? null : label, userDataDir: userData });
  }
  const personalLink = "codex://connector/oauth_callback?state=synthetic-only&code=fake%2Bvalue&returnTo=%2Fsettings%2Fplugins";
  await sendCodexLinkToTarget(receivers[1], personalLink);
  assert.equal(await waitForJson(`${receivers[1].output}.links`), personalLink);
  assert.equal(await exists(`${receivers[0].output}.links`), false, "Personal callback must not reach the main process");

  const mainLink = "codex://settings/plugins";
  await sendCodexLinkToTarget(receivers[0], mainLink);
  assert.equal(await waitForJson(`${receivers[0].output}.links`), mainLink);
  assert.equal((await fs.readFile(`${receivers[1].output}.links`, "utf8")).trim().split("\n").length, 1);

  await assert.rejects(sendCodexLinkToTarget({ ...receivers[1], executablePath: "/wrong/app" }, personalLink), /Could not deliver/);
  console.log("macOS browser link delivery passed: only the selected process received each synthetic link.");
} finally {
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
  })));
  await fs.rm(root, { recursive: true, force: true });
}

async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function waitForJson(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await exists(file)) {
      const value = await fs.readFile(file, "utf8");
      if (value.trim()) return JSON.parse(value);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the temporary Electron receiver.");
}
