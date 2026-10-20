import path from "node:path";
import { KeyedLock } from "./keyed-lock.js";
import { ensureDir, pathExists, readJsonFile } from "./fs-utils.js";
import { atomicWriteText } from "./settings-files.js";
import { getAppPaths, launcherFileName, resolveCodexDesktopApp, slugifyProfileName } from "./paths.js";
import type { CreateProfileInput, ManagedProfile, ProfileRegistry } from "../shared/types.js";

export const DEFAULT_PROFILE_ICON_BACKGROUND_COLOR = "#34C759";

const registryLock = new KeyedLock();

export async function listProfiles(): Promise<ManagedProfile[]> {
  const registry = await loadRegistry();
  return registry.profiles.filter((profile) => profile.status === "active").map(normalizeProfile);
}

export async function findProfile(profileId: string): Promise<ManagedProfile | null> {
  const registry = await loadRegistry();
  const profile = registry.profiles.find((item) => item.id === profileId);
  return profile ? normalizeProfile(profile) : null;
}

export async function createProfileRecord(input: CreateProfileInput): Promise<ManagedProfile> {
  return registryLock.run(getAppPaths().profilesFile, () => createRecord(input));
}

async function createRecord(input: CreateProfileInput): Promise<ManagedProfile> {
  const name = normalizeProfileName(input.name);
  const appPaths = getAppPaths();
  const registry = await loadRegistry();
  const existingIds = new Set(registry.profiles.map((profile) => profile.id));
  const baseSlug = slugifyProfileName(name);
  let id = baseSlug;
  let suffix = 2;

  while (existingIds.has(id) || await profileTargetsExist(id)) {
    id = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  const homeDir = path.join(appPaths.defaultProfileRoot, id);
  const codexHome = path.join(homeDir, "codex-home");
  const userDataDir = path.join(appPaths.defaultUserDataRoot, id, "user-data");
  const launcherPath = path.join(appPaths.defaultLauncherRoot, launcherFileName(id));
  const desktopApp = resolveCodexDesktopApp(input.codexAppPath);
  const now = new Date().toISOString();
  const profile: ManagedProfile = {
    id,
    name,
    status: "active",
    paths: {
      codexAppPath: desktopApp.appPath,
      homeDir,
      codexHome,
      userDataDir,
      launcherPath
    },
    auth: {
      mode: "chatgpt_account"
    },
    appearance: {
      iconBackgroundColor: normalizeHexColor(input.appearance?.iconBackgroundColor)
    },
    launch: {
      lastLaunchedAt: null,
      lastKnownPid: null,
      lastKnownUserDataDir: userDataDir
    },
    timestamps: {
      createdAt: now,
      updatedAt: now
    }
  };

  await Promise.all([
    ensureDir(codexHome),
    ensureDir(userDataDir),
    ensureDir(appPaths.defaultLauncherRoot)
  ]);
  registry.profiles.push(profile);
  await saveRegistry(registry);
  return profile;
}

export async function removeProfileRecord(profileId: string): Promise<ManagedProfile> {
  return registryLock.run(getAppPaths().profilesFile, () => removeRecord(profileId));
}

async function removeRecord(profileId: string): Promise<ManagedProfile> {
  const registry = await loadRegistry();
  const profile = registry.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Profile not found: ${profileId}`);
  registry.profiles = registry.profiles.filter((item) => item.id !== profileId);
  await saveRegistry(registry);
  return normalizeProfile(profile);
}

export async function repairProfileCodexAppPath(profile: ManagedProfile): Promise<ManagedProfile> {
  return registryLock.run(getAppPaths().profilesFile, () => repairAppPath(profile));
}

async function repairAppPath(profile: ManagedProfile): Promise<ManagedProfile> {
  const resolved = resolveCodexDesktopApp(profile.paths.codexAppPath);
  if (resolved.source !== "auto-detected" || resolved.appPath === profile.paths.codexAppPath) {
    return profile;
  }

  const registry = await loadRegistry();
  const stored = registry.profiles.find((item) => item.id === profile.id);
  if (!stored) throw new Error(`Profile not found: ${profile.id}`);
  stored.paths.codexAppPath = resolved.appPath;
  stored.timestamps.updatedAt = new Date().toISOString();
  await saveRegistry(registry);
  return normalizeProfile(stored);
}

export async function updateProfileLaunchMetadata(profileId: string, pid: number | null): Promise<void> {
  return registryLock.run(getAppPaths().profilesFile, () => updateLaunchMetadata(profileId, pid));
}

async function updateLaunchMetadata(profileId: string, pid: number | null): Promise<void> {
  const registry = await loadRegistry();
  const profile = registry.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Profile not found: ${profileId}`);
  profile.launch.lastLaunchedAt = new Date().toISOString();
  profile.launch.lastKnownPid = pid;
  profile.launch.lastKnownUserDataDir = profile.paths.userDataDir;
  profile.timestamps.updatedAt = new Date().toISOString();
  await saveRegistry(registry);
}

async function loadRegistry(): Promise<ProfileRegistry> {
  return readJsonFile<ProfileRegistry>(getAppPaths().profilesFile, { schemaVersion: 1, profiles: [] });
}

async function saveRegistry(registry: ProfileRegistry): Promise<void> {
  const filePath = getAppPaths().profilesFile;
  await ensureDir(path.dirname(filePath));
  await atomicWriteText(filePath, JSON.stringify(registry, null, 2) + "\n");
}

async function profileTargetsExist(id: string): Promise<boolean> {
  const appPaths = getAppPaths();
  const targets = [
    path.join(appPaths.defaultProfileRoot, id),
    path.join(appPaths.defaultUserDataRoot, id),
    path.join(appPaths.defaultLauncherRoot, launcherFileName(id))
  ];
  return (await Promise.all(targets.map(pathExists))).some(Boolean);
}

function normalizeProfileName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Profile name is required.");
  if (name.length > 64) throw new Error("Profile name must be 64 characters or fewer.");
  return name;
}

function normalizeProfile(profile: ManagedProfile): ManagedProfile {
  const homeDir = profile.paths.homeDir?.trim() || path.dirname(profile.paths.codexHome);
  return {
    ...profile,
    paths: {
      ...profile.paths,
      homeDir
    },
    auth: { mode: "chatgpt_account" },
    appearance: {
      iconBackgroundColor: normalizeHexColor(profile.appearance?.iconBackgroundColor)
    }
  };
}

function normalizeHexColor(value: string | undefined): string {
  const color = value?.trim();
  const short = color?.match(/^#?([0-9a-fA-F]{3})$/);
  if (short) {
    return `#${short[1].split("").map((character) => character.repeat(2)).join("").toUpperCase()}`;
  }
  const long = color?.match(/^#?([0-9a-fA-F]{6})$/);
  return long ? `#${long[1].toUpperCase()}` : DEFAULT_PROFILE_ICON_BACKGROUND_COLOR;
}
