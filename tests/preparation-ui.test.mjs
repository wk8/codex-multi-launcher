import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const componentSource = await fs.readFile(new URL("../src/renderer/PreparationFeedback.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(componentSource, { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
  .replace('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href));
const { PreparationFeedback } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const result = (status, messages = []) => ({ profileId: "x", status, event: "startup", checkedAt: "2026-01-01T00:00:00Z", messages, changedFiles: [] });
const render = (value) => renderToStaticMarkup(createElement(PreparationFeedback, { result: value, onRetry() {}, busy: false }));

test("profile feedback distinguishes blocked, pending, ready and disabled states", () => {
  assert.equal(render(undefined), "");
  assert.equal(render(result("disabled")), "");
  assert.match(render(result("blocked")), /Setup blocked.*Retry setup/);
  assert.match(render(result("deferred")), /Setup pending.*Retry setup/);
  assert.match(render(result("ready")), /Setup ready/);
  assert.doesNotMatch(render(result("ready")), /Retry setup/);
});

test("diagnostics render as text and never as executable markup", () => {
  const html = render(result("blocked", [{ severity: "error", code: "SCRIPT", message: '<img src=x onerror="alert(1)">', details: "<script>danger()</script>" }]));
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.doesNotMatch(html, /<img|<script/);
});

test("both preload entry points expose the same defaults IPC contract", async () => {
  for (const file of ["../src/preload/index.cjs", "../src/preload/index.ts"]) {
    const source = await fs.readFile(new URL(file, import.meta.url), "utf8");
    const code = file.endsWith(".ts") ? ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText : source;
    let api;
    const calls = [];
    const electron = {
      contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "codexProfileManager"); api = value; } },
      ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve(); } }
    };
    vm.runInNewContext(code, { exports: {}, require: (name) => { assert.equal(name, "electron"); return electron; } });
    await api.getPreparationResults();
    await api.previewProfileDefaults("profile");
    await api.retryProfilePreparation("profile");
    assert.deepEqual(calls, [["profiles:preparation"], ["profiles:preview-defaults", "profile"], ["profiles:retry-preparation", "profile"]]);
  }
});
