import { isDeepStrictEqual } from "node:util";
import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import { applyEdits, findNodeAtLocation, modify } from "jsonc-parser";
import { parseJsonObjectTree } from "./json-object.js";
import { isObject, type DefaultsPolicy, type SettingDefault } from "./defaults-policy.js";
import type { JsonValue, SettingChange } from "../shared/types.js";

type Mode = DefaultsPolicy["mode"];
interface EditResult { text: string; changes: Omit<SettingChange, "filePath">[] }

export function editJsonSettings(text: string | null, settings: SettingDefault[], mode: Mode): EditResult {
  let next = text ?? "{}\n";
  let tree = parseJsonObjectTree(next, "Desktop state");
  const changes: EditResult["changes"] = [];

  for (const setting of settings) {
    const previous = lookup(JSON.parse(next), setting.path);
    if (previous.exists && (mode === "fill-missing" || isDeepStrictEqual(previous.value, setting.value))) continue;
    if (isObject(previous.value)) throw new Error(`Default path is an object, not a leaf: ${JSON.stringify(setting.path)}.`);
    const node = findNodeAtLocation(tree, setting.path);
    const before = node ? next.slice(node.offset, node.offset + node.length) : null;
    next = applyEdits(next, modify(next, setting.path, setting.value, {}));
    tree = parseJsonObjectTree(next, "Desktop state");
    changes.push({ path: setting.path, before, after: JSON.stringify(setting.value) });
  }

  return { text: next, changes };
}

export function editTomlSettings(text: string | null, settings: SettingDefault[], mode: Mode): EditResult {
  let next = text ?? "";
  const changes: EditResult["changes"] = [];
  let ast = parse(next);

  for (const setting of settings) {
    const previous = lookup(getStaticTOMLValue(ast), setting.path);
    if (previous.exists && (mode === "fill-missing" || isDeepStrictEqual(previous.value, setting.value))) continue;
    if (isObject(previous.value)) throw new Error(`Default path is a table, not a leaf: ${JSON.stringify(setting.path)}.`);
    const replacement = tomlValue(setting.value);
    const location = findValue(ast, setting.path);
    const before = location ? next.slice(location.range[0], location.range[1]) : null;
    if (previous.exists && !location) {
      throw new Error(`Cannot replace an array of tables with a leaf default: ${JSON.stringify(setting.path)}.`);
    }

    if (location) {
      // A whole array is a value; keep comments from within it when replacing it.
      const comments = ast.comments.filter((comment) => comment.range[0] >= location.range[0] && comment.range[1] <= location.range[1]);
      const retained = comments.map((comment) => `#${comment.value}`).join("\n");
      const value = retained && Array.isArray(setting.value)
        ? `[\n${retained}\n${setting.value.map(tomlValue).join(", ")}\n]`
        : replacement;
      if (retained && !Array.isArray(setting.value)) {
        throw new Error(`Replacing this commented array with a scalar would lose comments: ${JSON.stringify(setting.path)}.`);
      }
      next = next.slice(0, location.range[0]) + value + next.slice(location.range[1]);
    } else {
      next = insertTomlValue(next, ast, setting.path, replacement);
    }

    ast = parse(next);
    if (!isDeepStrictEqual(lookup(getStaticTOMLValue(ast), setting.path).value, setting.value)) {
      throw new Error(`Could not represent the default in TOML: ${JSON.stringify(setting.path)}.`);
    }
    changes.push({ path: setting.path, before, after: replacement });
  }

  return { text: next, changes };
}

function parse(text: string): AST.TOMLProgram {
  return parseTOML(text, { tomlVersion: "1.0.0" });
}

function lookup(root: unknown, keys: string[]): { exists: boolean; value?: unknown } {
  let current = root;
  for (const key of keys) {
    if (!isObject(current)) throw new Error(`Default has a non-object parent: ${JSON.stringify(keys)}.`);
    if (!Object.hasOwn(current, key)) return { exists: false };
    current = current[key];
  }
  return { exists: true, value: current };
}

function findValue(ast: AST.TOMLProgram, keys: string[]): AST.TOMLContentNode | undefined {
  function visit(items: AST.TOMLKeyValue[], prefix: (string | number)[]): AST.TOMLContentNode | undefined {
    for (const item of items) {
      const full = [...prefix, ...getStaticTOMLValue(item.key)];
      if (samePath(full, keys)) return item.value;
      if (item.value.type === "TOMLInlineTable" && isPrefix(full, keys)) {
        const child = visit(item.value.body, full);
        if (child) return child;
      }
    }
    return undefined;
  }

  for (const item of ast.body[0].body) {
    const found = item.type === "TOMLTable" ? visit(item.body, item.resolvedKey) : visit([item], []);
    if (found) return found;
  }
  return undefined;
}

function insertTomlValue(text: string, ast: AST.TOMLProgram, keys: string[], value: string): string {
  // Inline tables cannot be extended with a separate dotted key outside them.
  for (let length = keys.length - 1; length > 0; length -= 1) {
    const parent = findValue(ast, keys.slice(0, length));
    if (parent?.type === "TOMLInlineTable") {
      const position = parent.range[1] - 1;
      const entry = `${parent.body.length ? ", " : " "}${tomlKey(keys.slice(length))} = ${value} `;
      return text.slice(0, position) + entry + text.slice(position);
    }
  }

  const tables = ast.body[0].body.filter((item): item is AST.TOMLTable => item.type === "TOMLTable");
  const table = tables.filter((item) => item.kind === "standard" && isPrefix(item.resolvedKey, keys))
    .sort((a, b) => b.resolvedKey.length - a.resolvedKey.length)[0];
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const nextTable = table ? tables[tables.indexOf(table) + 1] : tables[0];
  const position = nextTable ? text.lastIndexOf("\n", nextTable.range[0] - 1) + 1 : text.length;
  const prefix = position > 0 && text[position - 1] !== "\n" ? newline : "";
  const assignment = `${tomlKey(keys.slice(table?.resolvedKey.length ?? 0))} = ${value}${newline}`;
  return text.slice(0, position) + prefix + assignment + text.slice(position);
}

function isPrefix(a: (string | number)[], b: string[]): boolean {
  return a.length < b.length && a.every((key, index) => key === b[index]);
}

function samePath(a: (string | number)[], b: string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function tomlKey(keys: string[]): string {
  return keys.map((key) => /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)).join(".");
}

function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

function tomlValue(value: JsonValue): string {
  if (typeof value === "string") return tomlString(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isObject(value)) return `{ ${Object.entries(value).map(([key, child]) => `${tomlKey([key])} = ${tomlValue(child as JsonValue)}`).join(", ")} }`;
  if (value === null) throw new Error("TOML cannot represent null.");
  return JSON.stringify(value);
}
