import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchDesktopLinkTargets, sameDesktopTarget, validateCodexLink } from "../dist-electron/main/deep-links.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-routing-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const executable = path.join(root, "ChatGPT");
fs.writeFileSync(executable, "test fixture");
const profile = (id) => ({
  id, name: id, status: "active",
  paths: { codexAppPath: executable, userDataDir: `/test/Library/Application Support/Profiles/${id}/user-data` }
});
const profiles = [profile("perso"), profile("vn")];
const args = (id) => `--user-data-dir=${profile(id).paths.userDataDir}`;
const targets = matchDesktopLinkTargets(profiles, [
  { pid: 10, command: executable },
  { pid: 11, command: `${executable} ${args("perso")}` },
  { pid: 12, command: `${executable} ${args("vn")} --another-flag` },
  { pid: 13, command: `${executable} ${args("perso")}-other` },
  { pid: 14, command: `/test/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper ${args("perso")}` },
  { pid: 15, command: `/test/Helper.app/Contents/MacOS/Helper ${args("perso")}` },
  { pid: 16, command: `/bin/echo ${executable} ${args("perso")}` },
  { pid: 17, command: `${executable} --user-data-dir /unknown/profile` }
], executable);
assert.deepEqual(targets.map(({pid, profileId}) => [pid, profileId]), [[10, null], [11, "perso"], [12, "vn"]]);
assert.equal(sameDesktopTarget(targets[1], { ...targets[1] }), true);
for (const changed of [{pid: 999}, {profileId: "vn"}, {executablePath: "/other/app"}, {userDataDir: "/other/profile"}]) {
  assert.equal(sameDesktopTarget(targets[1], { ...targets[1], ...changed }), false);
}
const link = "codex://connector/oauth_callback?state=test%2Bstate&code=fake%3Dcode&returnTo=%2Fsettings%2Fplugins";
assert.equal(validateCodexLink(link), link);
assert.equal(validateCodexLink("codex://settings/plugins"), "codex://settings/plugins");
for (const invalid of [null, {}, "", "https://example.com", "codex://", "codex://user:pass@connector/path", "codex://connector:42/path", " codex://launch", "codex://launch\n", "codex://launch\u0000", `codex://launch?${"a".repeat(65536)}`]) {
  assert.throws(() => validateCodexLink(invalid), /valid codex/);
}
console.log("Browser link routing verification passed.");
