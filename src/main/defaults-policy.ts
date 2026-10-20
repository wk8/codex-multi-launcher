import type { JsonValue } from "../shared/types.js";

export interface SettingDefault {
  path: string[];
  value: JsonValue;
}

export interface DefaultsPolicy {
  schemaVersion: 1;
  enabled: boolean;
  scope: "new-profiles" | "all-managed-profiles";
  mode: "fill-missing" | "enforce";
  config: SettingDefault[];
  desktopState: SettingDefault[];
}

// The host can add ownership constraints when integrating the engine elsewhere.
export const LAUNCHER_OWNED_CONFIG_PATHS: readonly (readonly string[])[] = [
  ["model"], ["model_provider"], ["model_reasoning_effort"], ["model_providers"],
  ["forced_login_method"], ["forced_chatgpt_workspace_id"],
  ["cli_auth_credentials_store"], ["chatgpt_base_url"], ["openai_base_url"]
];

export function parseDefaultsPolicy(
  text: string,
  ownedPaths = LAUNCHER_OWNED_CONFIG_PATHS
): DefaultsPolicy {
  const raw: unknown = JSON.parse(text);
  assertObject(raw, "Policy");
  assertKeys(raw, ["schemaVersion", "enabled", "scope", "mode", "config", "desktopState"], "Policy");
  if (raw.schemaVersion !== 1) throw new Error("Policy schemaVersion must be 1.");
  if (typeof raw.enabled !== "boolean") throw new Error("Policy enabled must be a boolean.");
  if (raw.scope !== "new-profiles" && raw.scope !== "all-managed-profiles") {
    throw new Error("Policy scope must be new-profiles or all-managed-profiles.");
  }
  if (raw.mode !== "fill-missing" && raw.mode !== "enforce") {
    throw new Error("Policy mode must be fill-missing or enforce.");
  }

  const config = parseSettings(raw.config ?? [], "config", false);
  const desktopState = parseSettings(raw.desktopState ?? [], "desktopState", true);
  for (const setting of config) {
    if (ownedPaths.some((owned) => pathsOverlap(owned, setting.path))) {
      throw new Error(`The launcher owns config path ${JSON.stringify(setting.path)}; it cannot be a default.`);
    }
  }

  return { schemaVersion: 1, enabled: raw.enabled, scope: raw.scope, mode: raw.mode, config, desktopState };
}

function parseSettings(value: unknown, label: string, allowNull: boolean): SettingDefault[] {
  if (!Array.isArray(value) || value.length > 512) throw new Error(`${label} must be an array of at most 512 settings.`);
  const settings: SettingDefault[] = [];
  for (const item of value) {
    assertObject(item, `${label} entry`);
    assertKeys(item, ["path", "value"], `${label} entry`);
    if (!Array.isArray(item.path) || !item.path.length || item.path.length > 32
      || !item.path.every((key: unknown) => typeof key === "string" && key.length > 0 && key.length <= 512)) {
      throw new Error(`${label} path must contain 1–32 non-empty string keys.`);
    }
    const keys = item.path as string[];
    if (keys.some((key) => ["__proto__", "prototype", "constructor"].includes(key))) {
      throw new Error(`${label} path contains a reserved object key.`);
    }
    validateValue(item.value, allowNull);
    if (isObject(item.value)) throw new Error(`${label} defaults must target leaves; use separate paths for object members.`);
    if (settings.some((other) => pathsOverlap(other.path, keys))) {
      throw new Error(`${label} contains duplicate or overlapping paths: ${JSON.stringify(keys)}.`);
    }
    settings.push({ path: [...keys], value: item.value as JsonValue });
  }
  return settings;
}

function validateValue(value: unknown, allowNull: boolean, depth = 0): void {
  if (depth > 32) throw new Error("Default values may be at most 32 levels deep.");
  if (value === null && allowNull) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
  if (Array.isArray(value)) {
    for (const child of value) validateValue(child, allowNull, depth + 1);
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Default value contains a reserved object key.");
      validateValue(child, allowNull, depth + 1);
    }
    return;
  }
  throw new Error(`Unsupported default value${allowNull ? "" : " (TOML has no null value)"}.`);
}

export function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.slice(0, Math.min(a.length, b.length)).every((key, index) => key === b[index]);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
}

export function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}.`);
}
