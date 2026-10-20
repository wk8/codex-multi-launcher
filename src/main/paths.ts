import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppPaths } from "../shared/types.js";

export const APP_NAME = "Codex Personal Launcher";
export const DEFAULT_CODEX_APP_PATH = "/Applications/ChatGPT.app";

export interface PathProvider {
  home(): string;
  appData(): string;
  userData(): string;
}

export interface ResolvedDesktopApp {
  appPath: string;
  executablePath: string;
  source: "preferred" | "auto-detected" | "missing";
}

let pathProvider: PathProvider | null = null;

export function configurePathProvider(provider: PathProvider): void {
  pathProvider = provider;
}

function getPathProvider(): PathProvider {
  const overrideHome = process.env.CODEX_PERSONAL_LAUNCHER_HOME_OVERRIDE?.trim();
  if (overrideHome) {
    return nodePathProvider(overrideHome);
  }
  return pathProvider ?? nodePathProvider(os.homedir());
}

function nodePathProvider(home: string): PathProvider {
  const appData = () => path.join(home, "Library", "Application Support");
  return {
    home: () => home,
    appData,
    userData: () => path.join(appData(), APP_NAME)
  };
}

export function getAppPaths(): AppPaths {
  const provider = getPathProvider();
  const home = provider.home();
  const appDataDir = provider.userData();
  return {
    appDataDir,
    profilesFile: path.join(appDataDir, "profiles.json"),
    defaultProfileRoot: path.join(home, ".codex-personal-profiles"),
    defaultUserDataRoot: path.join(provider.appData(), "Codex Personal Profiles"),
    defaultLauncherRoot: path.join(home, "Applications", "Codex Personal Profiles")
  };
}

export function getLauncherUserHome(): string {
  return getPathProvider().home();
}

export function resolveCodexDesktopApp(preferredPath?: string | null): ResolvedDesktopApp {
  const preferred = preferredPath?.trim();
  if (preferred) {
    const resolved = resolveCandidate(preferred, "preferred");
    if (resolved) return resolved;
  }

  for (const candidate of [DEFAULT_CODEX_APP_PATH, "/Applications/Codex.app"]) {
    const resolved = resolveCandidate(candidate, "auto-detected");
    if (resolved) return resolved;
  }

  const appPath = preferred || DEFAULT_CODEX_APP_PATH;
  return {
    appPath,
    executablePath: expectedExecutablePath(appPath),
    source: "missing"
  };
}

export function codexExecutablePath(appPath: string): string {
  return resolveCodexDesktopApp(appPath).executablePath;
}

function resolveCandidate(appPath: string, source: "preferred" | "auto-detected"): ResolvedDesktopApp | null {
  if (path.extname(appPath).toLowerCase() !== ".app" && fileExists(appPath)) {
    return { appPath, executablePath: appPath, source };
  }

  for (const executableName of executableCandidates(appPath)) {
    const executablePath = path.join(appPath, "Contents", "MacOS", executableName);
    if (fileExists(executablePath)) {
      return { appPath, executablePath, source };
    }
  }
  return null;
}

function expectedExecutablePath(appPath: string): string {
  if (path.extname(appPath).toLowerCase() !== ".app") return appPath;
  return path.join(appPath, "Contents", "MacOS", readBundleExecutable(appPath) ?? "ChatGPT");
}

function executableCandidates(appPath: string): string[] {
  return [...new Set([readBundleExecutable(appPath), "ChatGPT", "Codex"].filter((value): value is string => Boolean(value)))];
}

function readBundleExecutable(appPath: string): string | null {
  try {
    const plist = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
    return plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile() || fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

export function slugifyProfileName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "personal";
}

export function launcherFileName(profileId: string): string {
  return `${profileId}.app`;
}
