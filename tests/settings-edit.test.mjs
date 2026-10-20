import assert from "node:assert/strict";
import test from "node:test";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { editJsonSettings, editTomlSettings } from "../dist-electron/main/settings-edit.js";

const setting = (path, value) => ({ path, value });
const parse = (text) => getStaticTOMLValue(parseTOML(text, { tomlVersion: "1.0.0" }));

test("TOML changes only selected values, preserving comments and unrelated syntax", () => {
  const source = '# introduction\nname = \'unchanged\' # personal\n[desktop] # header\nfollowUpQueueMode  = \'steer\' # why\nother = 0xFF\n[features]\nkeep = true\n';
  const edited = editTomlSettings(source, [setting(["desktop", "followUpQueueMode"], "queue")], "enforce");
  assert.equal(edited.text, source.replace("'steer'", '"queue"'));
  assert.equal(edited.changes.length, 1);
  assert.equal(parse(edited.text).features.keep, true);
});

test("TOML fill-missing and semantic no-ops preserve the exact original bytes", () => {
  const source = "answer = 0x2A # retained\n[desktop]\nqueue = 'steer'\n";
  assert.equal(editTomlSettings(source, [setting(["answer"], 42)], "enforce").text, source);
  assert.equal(editTomlSettings(source, [setting(["desktop", "queue"], "queue")], "fill-missing").text, source);
});

for (const [name, source, keys, expected] of [
  ["empty file", "", ["desktop", "queue"], { desktop: { queue: true } }],
  ["root before tables", "[other]\nx = 2\n", ["root"], { root: true, other: { x: 2 } }],
  ["existing table", "[desktop]\nx = 2\n[other]\ny = 3\n", ["desktop", "queue"], { desktop: { x: 2, queue: true }, other: { y: 3 } }],
  ["implicit table", "[desktop.child]\nx = 2\n", ["desktop", "queue"], { desktop: { queue: true, child: { x: 2 } } }],
  ["dotted keys", "desktop.child.x = 2\n", ["desktop", "child", "queue"], { desktop: { child: { x: 2, queue: true } } }],
  ["inline table", "desktop = { child = { x = 2 }, other = 3 }\n", ["desktop", "child", "queue"], { desktop: { child: { x: 2, queue: true }, other: 3 } }],
  ["dotted inline table", "desktop = { child.x = 2 }\n", ["desktop", "child", "queue"], { desktop: { child: { x: 2, queue: true } } }],
  ["empty inline table", "desktop = {} # retained\n", ["desktop", "queue"], { desktop: { queue: true } }],
  ["quoted dotted key", '"desktop.weird" = { "a.b" = false }\n', ["desktop.weird", "a.b"], { "desktop.weird": { "a.b": true } }],
  ["quoted table", '["desktop.weird"]\n"a.b" = false\n', ["desktop.weird", "a.b"], { "desktop.weird": { "a.b": true } }],
  ["no trailing newline", "existing = 1", ["queue"], { existing: 1, queue: true }],
  ["CRLF", "[desktop]\r\nx = 1\r\n", ["desktop", "queue"], { desktop: { x: 1, queue: true } }]
]) {
  test(`TOML insertion/replacement handles ${name}`, () => {
    const edited = editTomlSettings(source, [setting(keys, true)], "enforce");
    assert.deepEqual(parse(edited.text), expected);
    assert.equal(editTomlSettings(edited.text, [setting(keys, true)], "enforce").text, edited.text);
  });
}

test("TOML preserves unrelated timestamps, arrays of tables, and multiline strings", () => {
  const source = 'intro = """A\nB"""\ntime = 1979-05-27T07:32:00Z\n[[servers]]\nx = 1\n[[servers]]\nx = 2\n';
  const edited = editTomlSettings(source, [setting(["desktop", "queue"], "queue")], "enforce");
  assert.ok(edited.text.includes(source.slice(0, source.indexOf("[[servers]]"))));
  assert.ok(edited.text.includes(source.slice(source.indexOf("[[servers]]"))));
  assert.equal(parse(edited.text).desktop.queue, "queue");
});

test("TOML array replacement keeps its internal comments and replaces the whole array", () => {
  const source = 'efforts = [\n  "low", # low explanation\n  # high explanation\n  "high"\n] # after\n';
  const edited = editTomlSettings(source, [setting(["efforts"], ["ultra", "max"])], "enforce");
  assert.deepEqual(parse(edited.text).efforts, ["ultra", "max"]);
  for (const comment of ["# low explanation", "# high explanation", "# after"]) assert.ok(edited.text.includes(comment));
});

test("TOML serializes escaped strings, array objects and multiline instruction values", () => {
  const value = "first\nsecond\tquote\"slash\\unicode🐈\u007f";
  const settings = [setting(["instruction", "a.b"], value), setting(["items"], [{ "a.b": "test", x: [1, false] }])];
  const edited = editTomlSettings(null, settings, "enforce");
  assert.equal(parse(edited.text).instruction["a.b"], value);
  assert.deepEqual(parse(edited.text).items, settings[1].value);
});

for (const source of ["a = [", "a=1\na=2\n", "a=1\n[a]\nb=2\n"]) {
  test(`TOML rejects malformed input ${JSON.stringify(source)}`, () => assert.throws(() => editTomlSettings(source, [setting(["b"], true)], "enforce")));
}

test("TOML rejects incompatible parents and non-leaf table replacement", () => {
  for (const source of ['desktop = "text"\n', "desktop = [1, 2]\n"]) {
    assert.throws(() => editTomlSettings(source, [setting(["desktop", "queue"], true)], "enforce"), /non-object parent/);
  }
  assert.throws(() => editTomlSettings("[desktop]\nqueue=true\n", [setting(["desktop"], false)], "enforce"), /not a leaf/);
  assert.throws(() => editTomlSettings("[[items]]\nx=1\n", [setting(["items"], [])], "enforce"), /array of tables/);
});

test("JSON replaces only selected paths and preserves unrelated state", () => {
  const original = { "electron-persisted-atom-state": { "a.b": false, keep: [1, 2] }, opaque: { text: "retain", nested: null } };
  const edited = editJsonSettings(JSON.stringify(original), [setting(["electron-persisted-atom-state", "a.b"], true), setting(["new", "deep"], ["x"])], "enforce");
  assert.deepEqual(JSON.parse(edited.text), { ...original, "electron-persisted-atom-state": { "a.b": true, keep: [1, 2] }, new: { deep: ["x"] } });
});

test("JSON fill-missing distinguishes present null/false/zero from absent paths", () => {
  const text = '{ "n": null, "b": false, "z": 0 }\n';
  const settings = [setting(["n"], 1), setting(["b"], true), setting(["z"], 2)];
  assert.equal(editJsonSettings(text, settings, "fill-missing").text, text);
  assert.equal(editJsonSettings(text, [setting(["n"], null)], "enforce").text, text);
  assert.deepEqual(JSON.parse(editJsonSettings(null, [setting(["n"], null)], "enforce").text), { n: null });
});

test("JSON rejects malformed state, root arrays and incompatible parents", () => {
  for (const text of ["", "[1]", "null", "{", '{"a":1,"a":2}', '{"a":1,}', '{"a":1 /* comment */}']) assert.throws(() => editJsonSettings(text, [setting(["a"], true)], "enforce"));
  for (const value of [null, [], "string", 1]) {
    assert.throws(() => editJsonSettings(JSON.stringify({ a: value }), [setting(["a", "b"], true)], "enforce"), /non-object parent/);
  }
});

test("JSON preserves unrelated numeric precision, whitespace and string escaping", () => {
  const source = '{ "big": 9007199254740993, "escaped": "\\u0041", "queue" : false }\r\n';
  const edited = editJsonSettings(source, [setting(["queue"], true)], "enforce");
  assert.equal(edited.text, source.replace("false", "true"));
  const added = editJsonSettings(source, [setting(["new", "path"], true)], "enforce");
  assert.ok(added.text.includes("9007199254740993"));
  assert.ok(added.text.includes('"\\u0041"'));
});
