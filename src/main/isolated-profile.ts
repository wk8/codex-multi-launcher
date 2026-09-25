import fs from "node:fs/promises";
import path from "node:path";
import { getAppPaths } from "./paths.js";
import type { ManagedProfile } from "../shared/types.js";

const CONFIG_HEADER = [
  "# Personal profile created by Codex Personal Launcher.",
  "# HOME and CODEX_HOME are pinned to separate locations inside this isolated profile.",
  "# No settings, history, plugins, skills, MCP configuration, or credentials were inherited.",
  ""
].join("\n");

export async function initializeIsolatedProfile(profile: ManagedProfile): Promise<string> {
  assertIsolatedProfile(profile);
  const [codexEntries, userDataEntries] = await Promise.all([
    fs.readdir(profile.paths.codexHome),
    fs.readdir(profile.paths.userDataDir)
  ]);
  if (codexEntries.length || userDataEntries.length) {
    throw new Error("Refusing to initialize a personal profile in non-empty storage.");
  }

  await ensureIsolatedProfileHome(profile);
  const configPath = path.join(profile.paths.codexHome, "config.toml");
  await fs.writeFile(configPath, CONFIG_HEADER, { mode: 0o600, flag: "wx" });
  return configPath;
}

export async function ensureIsolatedProfileHome(profile: ManagedProfile): Promise<void> {
  assertIsolatedProfile(profile);
  await Promise.all([
    fs.mkdir(getProfileUserSkillsPath(profile), { recursive: true, mode: 0o700 }),
    fs.mkdir(getProfileCodexSkillsPath(profile), { recursive: true, mode: 0o700 })
  ]);
}

export function getProfileUserSkillsPath(profile: ManagedProfile): string {
  assertIsolatedProfile(profile);
  return path.join(profile.paths.homeDir, ".agents", "skills");
}

export function getProfileCodexSkillsPath(profile: ManagedProfile): string {
  assertIsolatedProfile(profile);
  return path.join(profile.paths.codexHome, "skills");
}

export function assertIsolatedProfile(profile: ManagedProfile): void {
  if (profile.auth.mode !== "chatgpt_account") {
    throw new Error("Only ChatGPT account profiles are permitted.");
  }
  const appPaths = getAppPaths();
  assertInside(profile.paths.homeDir, appPaths.defaultProfileRoot, "HOME");
  assertInside(profile.paths.codexHome, appPaths.defaultProfileRoot, "CODEX_HOME");
  assertInside(profile.paths.userDataDir, appPaths.defaultUserDataRoot, "user-data directory");
  assertInside(profile.paths.launcherPath, appPaths.defaultLauncherRoot, "launcher");
  if (path.resolve(profile.paths.codexHome) !== path.resolve(profile.paths.homeDir, "codex-home")) {
    throw new Error(`Refusing CODEX_HOME outside the isolated HOME: ${profile.paths.codexHome}`);
  }
}

function assertInside(candidate: string, root: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing unsafe ${label} path: ${candidate}`);
  }
}
