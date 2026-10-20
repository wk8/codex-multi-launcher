import assert from "node:assert/strict";
import test from "node:test";
import { parseDefaultsPolicy } from "../dist-electron/main/defaults-policy.js";
import { policy } from "./helpers.mjs";

test("policy accepts explicit modes, scopes and punctuation in path segments", () => {
  for (const mode of ["fill-missing", "enforce"]) {
    for (const scope of ["new-profiles", "all-managed-profiles"]) {
      const value = policy({ mode, scope, config: [{ path: ["desktop", "a.b-c"], value: ["high", "ultra"] }] });
      assert.deepEqual(parseDefaultsPolicy(JSON.stringify(value)), value);
    }
  }
});

for (const [name, overrides] of [
  ["unknown version", { schemaVersion: 2 }],
  ["implicit enabled", { enabled: "true" }],
  ["unknown scope", { scope: "all" }],
  ["unknown mode", { mode: "merge" }],
  ["typo", { desktopStates: [] }],
  ["nonarray settings", { config: {} }],
  ["dotted string path", { config: [{ path: "desktop.queue", value: true }] }],
  ["empty path", { config: [{ path: [], value: true }] }],
  ["numeric segment", { config: [{ path: ["desktop", 0], value: true }] }],
  ["prototype mutation", { config: [{ path: ["__proto__", "polluted"], value: true }] }],
  ["constructor mutation", { desktopState: [{ path: ["constructor", "prototype", "x"], value: true }] }],
  ["missing value", { config: [{ path: ["desktop"] }] }],
  ["null TOML value", { config: [{ path: ["test"], value: [null] }] }],
  ["non-leaf default", { config: [{ path: ["desktop"], value: { queue: true } }] }],
  ["unsafe integer", { config: [{ path: ["test"], value: Number.MAX_SAFE_INTEGER + 1 }] }],
  ["unknown entry field", { config: [{ path: ["test"], value: true, replace: true }] }],
  ["duplicate path", { config: [{ path: ["test"], value: true }, { path: ["test"], value: false }] }],
  ["overlapping paths", { desktopState: [{ path: ["test"], value: true }, { path: ["test", "child"], value: false }] }],
  ["reverse overlapping paths", { config: [{ path: ["test", "child"], value: true }, { path: ["test"], value: false }] }],
  ["too many settings", { config: Array.from({ length: 513 }, (_, i) => ({ path: [String(i)], value: true })) }]
]) {
  test(`policy rejects ${name}`, () => assert.throws(() => parseDefaultsPolicy(JSON.stringify(policy(overrides)))));
}

for (const key of ["model", "model_provider", "model_reasoning_effort", "model_providers", "forced_login_method", "cli_auth_credentials_store"]) {
  test(`policy protects launcher-owned ${key}`, () => {
    assert.throws(() => parseDefaultsPolicy(JSON.stringify(policy({ config: [{ path: [key], value: "value" }] }))), /launcher owns/);
    assert.throws(() => parseDefaultsPolicy(JSON.stringify(policy({ config: [{ path: [key, "child"], value: "value" }] }))), /launcher owns/);
  });
}

test("host ownership extensions reject both ancestors and descendants", () => {
  const source = (keys) => JSON.stringify(policy({ config: [{ path: keys, value: true }] }));
  assert.throws(() => parseDefaultsPolicy(source(["host"]), [["host", "owned"]]), /launcher owns/);
  assert.throws(() => parseDefaultsPolicy(source(["host", "owned", "child"]), [["host", "owned"]]), /launcher owns/);
  assert.doesNotThrow(() => parseDefaultsPolicy(source(["host", "other"]), [["host", "owned"]]));
});

test("JSON null is a value and malicious keys in array objects are rejected", () => {
  assert.equal(parseDefaultsPolicy(JSON.stringify(policy({ desktopState: [{ path: ["a"], value: null }] }))).desktopState[0].value, null);
  const value = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => parseDefaultsPolicy(JSON.stringify(policy({ desktopState: [{ path: ["a"], value: [value] }] }))), /reserved/);
  assert.equal({}.polluted, undefined);
});

test("invalid JSON and oversized nesting fail closed", () => {
  assert.throws(() => parseDefaultsPolicy("{"));
  let value = 1;
  for (let i = 0; i < 34; i++) value = [value];
  assert.throws(() => parseDefaultsPolicy(JSON.stringify(policy({ config: [{ path: ["a"], value }] }))), /levels/);
});
