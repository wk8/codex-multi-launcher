import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertIsolatedProfile,
  assertIsolatedProfileStorage,
  ensureIsolatedProfileHome,
  initializeIsolatedProfile
} from "./isolated-profile.js";
import { generateLauncher } from "./launcher.js";
import { codexExecutablePath, getAppPaths } from "./paths.js";
import { KeyedLock } from "./keyed-lock.js";
import { ProfilePreparation } from "./profile-preparation.js";
import { pathExists } from "./fs-utils.js";
import {
  createProfileRecord,
  findProfile,
  listProfiles,
  removeProfileRecord,
  repairProfileCodexAppPath,
  updateProfileLaunchMetadata
} from "./registry.js";
import { getRuntimeStatus as inspectRuntimeStatus } from "./runtime.js";
import type {
  CreateProfileInput,
  CreateProfileResult,
  LauncherResult,
  ManagedProfile,
  PreparationPreview,
  PreparationResult,
  ProfileRuntimeInfo
} from "../shared/types.js";

export { listProfiles };

const profileLocks = new KeyedLock();
const pendingOpens = new Map<string, Promise<{ pid: number | null }>>();
const launchedChildren = new Map<string, ChildProcess>();

function profileKey(profileId: string): string {
  return `${getAppPaths().appDataDir}:${profileId}`;
}

function preparation(): ProfilePreparation {
  return new ProfilePreparation({
    dataDir: getAppPaths().appDataDir,
    inspect: inspectProfile,
    assertStorage: assertIsolatedProfileStorage
  });
}

async function inspectProfile(profile: ManagedProfile): Promise<ProfileRuntimeInfo> {
  const child = launchedChildren.get(profileKey(profile.id));
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    return { profileId: profile.id, status: "running", pid: child.pid, detail: "The launcher is tracking this desktop process." };
  }
  return (await inspectRuntimeStatus([profile]))[0];
}

interface LaunchLog {
  path: string;
  append(message: string, details?: Record<string, unknown>): Promise<void>;
}

export async function getRuntimeStatus(): Promise<ProfileRuntimeInfo[]> {
  return Promise.all((await listProfiles()).map(inspectProfile));
}

export async function getPreparationResults(): Promise<PreparationResult[]> {
  const coordinator = preparation();
  const results = await Promise.all((await listProfiles()).map((profile) => coordinator.readResult(profile.id)));
  return results.filter((result): result is PreparationResult => result !== null);
}

export async function previewProfileDefaults(profileId: string): Promise<PreparationPreview> {
  return profileLocks.run(profileKey(profileId), async () => preparation().preview(await mustFindProfile(profileId)));
}

export async function retryProfilePreparation(profileId: string): Promise<PreparationResult> {
  return profileLocks.run(profileKey(profileId), async () => {
    const coordinator = preparation();
    const previous = await coordinator.readResult(profileId);
    return coordinator.prepare(await mustFindProfile(profileId), previous?.setupPending ? "create" : "startup");
  });
}

export async function createProfile(input: CreateProfileInput): Promise<CreateProfileResult> {
  rejectLegacyFeatures(input);
  const profile = await createProfileRecord(input);
  return profileLocks.run(profileKey(profile.id), async () => {
    let configPath: string;
    let launcher: LauncherResult;
    try {
      configPath = await initializeIsolatedProfile(profile);
      launcher = await generateLauncher(profile);
    } catch (error) {
      await cleanupFailedProfileCreation(profile);
      throw error;
    }

    // Preparation failures retain the initialized profile for inspection/retry.
    const result = await preparation().prepare(profile, "create");
    return { profile, configPath, launcherPath: launcher.launcherPath, preparation: result };
  });
}

export async function generateProfileLauncher(profileId: string): Promise<LauncherResult> {
  return profileLocks.run(profileKey(profileId), async () => {
    const profile = await mustFindProfile(profileId);
    await assertIsolatedProfileStorage(profile);
    if ((await inspectProfile(profile)).status !== "not_running") throw new Error("Close the profile before rebuilding its shortcut.");
    await ensureIsolatedProfileHome(profile);
    return generateLauncher(profile);
  });
}

export async function refreshActiveProfileLaunchers(): Promise<PreparationResult[]> {
  const profiles = await listProfiles();
  return Promise.all(profiles.map((profile) => profileLocks.run(profileKey(profile.id), async () => {
    const coordinator = preparation();
    const result = await coordinator.prepare(profile, "startup");
    if (result.status === "blocked" || result.status === "deferred") return result;
    try {
      if ((await inspectProfile(profile)).status === "not_running") {
        await assertIsolatedProfileStorage(profile);
        await ensureIsolatedProfileHome(profile);
        await generateLauncher(profile);
      }
      return result;
    } catch (error) {
      return coordinator.recordFailure(profile, "startup", error);
    }
  })));
}

export async function getProfileLauncherPath(profileId: string): Promise<string> {
  const profile = await mustFindProfile(profileId);
  assertIsolatedProfile(profile);
  return profile.paths.launcherPath;
}

export async function permanentlyDeleteProfile(profileId: string): Promise<{ ok: true }> {
  return profileLocks.run(profileKey(profileId), () => deleteStoppedProfile(profileId));
}

async function deleteStoppedProfile(profileId: string): Promise<{ ok: true }> {
  const profile = await mustFindProfile(profileId);
  assertIsolatedProfile(profile);
  if ((await inspectProfile(profile)).status !== "not_running") throw new Error("Close the profile before deleting it.");
  await removeProfileRecord(profileId);
  await Promise.all([
    fs.rm(profile.paths.homeDir, { force: true, recursive: true }),
    fs.rm(profile.paths.userDataDir, { force: true, recursive: true }),
    fs.rm(profile.paths.launcherPath, { force: true, recursive: true })
  ]);
  await preparation().forget(profileId);
  return { ok: true };
}

export async function openProfile(profileId: string): Promise<{ pid: number | null }> {
  const key = profileKey(profileId);
  const pending = pendingOpens.get(key);
  if (pending) return pending;
  const next = profileLocks.run(key, () => openPreparedProfile(profileId));
  pendingOpens.set(key, next);
  try {
    return await next;
  } finally {
    if (pendingOpens.get(key) === next) pendingOpens.delete(key);
  }
}

async function openPreparedProfile(profileId: string): Promise<{ pid: number | null }> {
  const profile = await repairProfileCodexAppPath(await mustFindProfile(profileId));
  await assertIsolatedProfileStorage(profile);
  const result = await preparation().prepare(profile, "launch");
  if (result.status === "blocked") throw new Error(result.messages.map((message) => message.message).join("\n"));
  const runtime = await inspectProfile(profile);
  if (runtime.status === "running") return { pid: runtime.pid };
  if (result.status === "deferred" || runtime.status === "unknown") {
    throw new Error("Profile setup is pending because its runtime is unknown. Retry after closing the profile.");
  }
  await ensureIsolatedProfileHome(profile);
  const log = await createLaunchLog(profile);
  const executablePath = codexExecutablePath(profile.paths.codexAppPath);
  await log.append("isolated profile launch requested", {
    profileId: profile.id,
    home: profile.paths.homeDir,
    codexHome: profile.paths.codexHome,
    userDataDir: profile.paths.userDataDir,
    desktopApp: profile.paths.codexAppPath
  });

  if (!(await pathExists(executablePath))) {
    throw new Error(`ChatGPT/Codex desktop executable was not found: ${executablePath}`);
  }

  const launcher = await generateLauncher(profile);
  const output = await openLaunchOutput(profile);
  const child = spawn(launcher.executablePath, [], detachedSpawnOptions(profile, executablePath, output.fd));
  const key = profileKey(profileId);
  launchedChildren.set(key, child);
  child.once("error", (error) => {
    launchedChildren.delete(key);
    output.close();
    void log.append("desktop app process error", { message: error.message });
  });
  child.once("exit", (code, signal) => {
    launchedChildren.delete(key);
    output.close();
    void log.append("desktop app process exited", { code, signal });
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await log.append("desktop app process spawned", { pid: child.pid ?? null });
  child.unref();
  await updateProfileLaunchMetadata(profile.id, child.pid ?? null);
  return { pid: child.pid ?? null };
}

function detachedSpawnOptions(profile: ManagedProfile, executablePath: string, outputFd: number): SpawnOptions {
  return {
    cwd: path.dirname(executablePath),
    detached: true,
    env: isolatedLaunchEnvironment(profile, executablePath),
    stdio: ["ignore", outputFd, outputFd]
  };
}

function isolatedLaunchEnvironment(profile: ManagedProfile, executablePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      !/^(OPENAI|CODEX|CHATGPT|ELECTRON)_/i.test(key)
      && !/^(HOME|USERPROFILE|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|XDG_STATE_HOME|BASH_ENV|ENV|ZDOTDIR)$/i.test(key)
    ) {
      env[key] = value;
    }
  }
  env.HOME = profile.paths.homeDir;
  env.USERPROFILE = profile.paths.homeDir;
  env.XDG_CONFIG_HOME = path.join(profile.paths.homeDir, ".config");
  env.XDG_CACHE_HOME = path.join(profile.paths.homeDir, ".cache");
  env.XDG_DATA_HOME = path.join(profile.paths.homeDir, ".local", "share");
  env.XDG_STATE_HOME = path.join(profile.paths.homeDir, ".local", "state");
  env.ZDOTDIR = profile.paths.homeDir;
  env.CODEX_HOME = profile.paths.codexHome;
  env.CODEX_PERSONAL_HOME = profile.paths.homeDir;
  env.USER_DATA_DIR = profile.paths.userDataDir;
  env.CODEX_PERSONAL_LAUNCH = "1";
  env.CHATGPT_EXE = executablePath;
  return env;
}

async function cleanupFailedProfileCreation(profile: ManagedProfile): Promise<void> {
  assertIsolatedProfile(profile);
  await removeProfileRecord(profile.id).catch(() => undefined);
  await Promise.all([
    fs.rm(profile.paths.homeDir, { force: true, recursive: true }),
    fs.rm(profile.paths.userDataDir, { force: true, recursive: true }),
    fs.rm(profile.paths.launcherPath, { force: true, recursive: true })
  ]);
}

function rejectLegacyFeatures(input: CreateProfileInput): void {
  const raw = input as unknown as Record<string, unknown>;
  const forbidden = [
    "authMode",
    "inheritDefaultConfig",
    "provider",
    "subscriptionAuthorizationSessionId",
    "syncHistory"
  ].filter((field) => Object.prototype.hasOwnProperty.call(raw, field));
  if (forbidden.length) {
    throw new Error(`Unsupported personal-profile fields: ${forbidden.join(", ")}`);
  }
}

async function createLaunchLog(profile: ManagedProfile): Promise<LaunchLog> {
  const logDirectory = path.join(profile.paths.codexHome, "logs");
  await fs.mkdir(logDirectory, { recursive: true });
  const logPath = path.join(logDirectory, "desktop-launch.log");
  return {
    path: logPath,
    append: async (message, details) => {
      const suffix = details ? ` ${JSON.stringify(details)}` : "";
      await fs.appendFile(logPath, `[${new Date().toISOString()}] ${message}${suffix}\n`, "utf8");
    }
  };
}

async function openLaunchOutput(profile: ManagedProfile): Promise<{ fd: number; close(): void }> {
  const logDirectory = path.join(profile.paths.codexHome, "logs");
  await fs.mkdir(logDirectory, { recursive: true });
  const fd = nodeFs.openSync(path.join(logDirectory, "desktop-output.log"), "a");
  let closed = false;
  return {
    fd,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        nodeFs.closeSync(fd);
      } catch {
        // The child process may already have closed the inherited descriptor.
      }
    }
  };
}

async function mustFindProfile(profileId: string): Promise<ManagedProfile> {
  const profile = await findProfile(profileId);
  if (!profile) throw new Error(`Profile not found: ${profileId}`);
  return profile;
}
