import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { CommandDiagnostics, PreparationEvent, PreparationMessage } from "../shared/types.js";
import { assertKeys, assertObject, type PreparationCommand } from "./defaults-policy.js";
import { parseJsonObject } from "./json-object.js";

export interface CommandProfile {
  id: string;
  name: string;
  authMode: string;
  homeIsolated: boolean;
  paths: {
    homeDir: string;
    codexHome: string;
    configFile: string;
    globalStateFile: string;
    agentsFile: string;
    userDataDir: string;
    launcherPath: string;
    desktopAppPath: string;
    desktopExecutablePath: string;
  };
  appearance?: { iconBackgroundColor: string };
}

export interface CommandInput {
  protocolVersion: 1;
  event: PreparationEvent;
  invocationId: string;
  platform: NodeJS.Platform;
  profile: CommandProfile;
  launcher: { userHomeDir: string; dataDir: string; policyFile: string };
  execution: { cwd: string };
}

export interface CommandResult {
  messages: PreparationMessage[];
  diagnostics: CommandDiagnostics;
}

export const COMMAND_STDOUT_LIMIT = 64 * 1024;
export const COMMAND_STDERR_LIMIT = 16 * 1024;

export function buildCommandInput(
  profile: CommandProfile, event: PreparationEvent, invocationId: string,
  launcher: CommandInput["launcher"], cwd: string
): CommandInput {
  const paths = Object.fromEntries([
    "homeDir", "codexHome", "configFile", "globalStateFile", "agentsFile", "userDataDir",
    "launcherPath", "desktopAppPath", "desktopExecutablePath"
  ].map((key) => [key, profile.paths[key as keyof CommandProfile["paths"]]])) as CommandProfile["paths"];
  const launcherPaths = { userHomeDir: launcher.userHomeDir, dataDir: launcher.dataDir, policyFile: launcher.policyFile };
  if (Object.values({ ...paths, ...launcherPaths, cwd }).some((value) => typeof value !== "string" || !path.isAbsolute(value))) {
    throw new Error("Preparation command context paths must be absolute.");
  }
  return {
    protocolVersion: 1, event, invocationId, platform: process.platform,
    profile: {
      id: profile.id, name: profile.name, authMode: profile.authMode, homeIsolated: profile.homeIsolated, paths,
      ...(profile.appearance ? { appearance: { iconBackgroundColor: profile.appearance.iconBackgroundColor } } : {})
    },
    launcher: launcherPaths,
    execution: { cwd }
  };
}

export function resolveCommand(command: PreparationCommand, policyFile: string): PreparationCommand & { cwd: string } {
  const directory = path.dirname(policyFile);
  return {
    ...command,
    executable: command.executable.includes(path.sep) ? path.resolve(directory, command.executable) : command.executable,
    cwd: path.resolve(directory, command.cwd ?? ".")
  };
}

export function parseCommandResponse(text: string): PreparationMessage[] {
  const response = parseJsonObject(text, "Command response");
  assertKeys(response, ["protocolVersion", "messages"], "Command response");
  if (response.protocolVersion !== 1) throw new Error("Command protocolVersion must be 1.");
  if (!Array.isArray(response.messages) || response.messages.length > 100) throw new Error("Command messages must be an array of at most 100 entries.");
  const codes = new Set<string>();
  return response.messages.map((message): PreparationMessage => {
    assertObject(message, "Command message");
    assertKeys(message, ["severity", "code", "message", "details"], "Command message");
    if (message.severity !== "info" && message.severity !== "warning" && message.severity !== "error") throw new Error("Unknown command message severity.");
    if (typeof message.code !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(message.code)
      || message.code.startsWith("LAUNCHER_") || codes.has(message.code)) throw new Error("Command message codes must be unique identifiers without the reserved LAUNCHER_ prefix.");
    if (typeof message.message !== "string" || !message.message.trim() || message.message.length > 8192) throw new Error("Command messages require non-empty text of at most 8192 characters.");
    if (message.details !== undefined && (typeof message.details !== "string" || message.details.length > 32768)) throw new Error("Command details must be text of at most 32768 characters.");
    codes.add(message.code);
    return { severity: message.severity, code: message.code, message: message.message,
      ...(message.details === undefined ? {} : { details: message.details as string }) };
  });
}

export async function runPreparationCommand(
  command: PreparationCommand & { cwd: string }, input: CommandInput,
  onStarted?: (processGroupId: number) => Promise<void>
): Promise<CommandResult> {
  const inputText = JSON.stringify(input) + "\n";
  const started = performance.now();
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let stderrBytes = 0;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let closed = false;
  let forced: PreparationMessage | undefined;
  let wakeFailure: () => void;
  const failed = new Promise<void>((resolve) => { wakeFailure = resolve; });
  const fail = (code: string, message: string) => {
    if (!forced) forced = { severity: "error", code: `LAUNCHER_${code}`, message };
    wakeFailure();
  };

  // This build is macOS-only. A Windows host must supply Job Object ownership
  // rather than falling back to killing only the parent command process.
  if (process.platform === "win32") {
    return { messages: [{ severity: "error", code: "LAUNCHER_COMMAND_PLATFORM", message: "This command runner requires POSIX process groups." }],
      diagnostics: { exitCode: null, signal: null, durationMs: 0, stderr: "", stderrTruncated: false, processGroupId: null, cleanupPending: false } };
  }

  const child = spawn(command.executable, command.args, {
    cwd: command.cwd, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"]
  });
  const completion = new Promise<void>((resolve) => {
    child.once("close", (code, terminationSignal) => {
      exitCode = code;
      signal = terminationSignal;
      closed = true;
      resolve();
    });
  });
  const spawned = new Promise<boolean>((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
  child.once("error", (error) => fail("COMMAND_START_FAILED", `Could not start the preparation command: ${error.message}`));
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") fail("COMMAND_INPUT_FAILED", `Could not send command input: ${error.message}`);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (forced) return;
    if (stdout.length + chunk.length > COMMAND_STDOUT_LIMIT) fail("COMMAND_OUTPUT_LIMIT", "Preparation command stdout exceeded 64 KiB.");
    else stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderr = Buffer.concat([stderr, chunk]).subarray(-COMMAND_STDERR_LIMIT);
  });
  const timer = setTimeout(() => fail("COMMAND_TIMEOUT", `Preparation command exceeded its ${command.timeoutMs} ms timeout.`), command.timeoutMs);

  let cleanupPending = false;
  try {
    if (await spawned) {
      try {
        await onStarted?.(child.pid!);
        if (!forced) child.stdin.end(inputText);
      } catch {
        fail("COMMAND_RECORD_FAILED", "Could not record the running preparation command. Its profile input was not sent.");
      }
    }
    await Promise.race([completion, failed]);
    if (!forced && commandGroupExists(child.pid)) {
      fail("COMMAND_CHILDREN_RUNNING", "Preparation command exited with background processes still running. Commands must finish all child work before exiting.");
    }
    if (forced) cleanupPending = !(await stopCommandGroup(child, () => closed));
    if (!closed) await Promise.race([completion, delay(100)]);
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }

  let messages: PreparationMessage[] = [];
  if (!forced || stdout.length) {
    try {
      messages = parseCommandResponse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout));
    } catch (error) {
      if (!forced) messages.push({
        severity: "error", code: "LAUNCHER_COMMAND_PROTOCOL",
        message: "Preparation command stdout must be exactly one valid protocolVersion 1 JSON response with a messages array. Put logs on stderr.",
        details: error instanceof Error ? error.message.slice(0, 4096) : "Invalid command response."
      });
    }
  }
  if (forced) messages.push(forced);
  if (!forced && (exitCode !== 0 || signal !== null)) {
    messages.push({ severity: "error", code: "LAUNCHER_COMMAND_EXIT", message: signal ? `Preparation command terminated by ${signal}.` : `Preparation command exited with code ${exitCode}.` });
  }
  if (cleanupPending) {
    messages.push({ severity: "error", code: "LAUNCHER_COMMAND_CLEANUP", message: "Command cleanup could not be confirmed. This profile stays blocked until the command process group has stopped." });
  }
  return {
    messages,
    diagnostics: { exitCode, signal, durationMs: Math.round(performance.now() - started), stderr: stderr.toString("utf8"),
      stderrTruncated: stderrBytes > COMMAND_STDERR_LIMIT, processGroupId: child.pid ?? null, cleanupPending }
  };
}

export function commandGroupExists(pid: number | null | undefined): boolean {
  if (!Number.isSafeInteger(pid) || pid! <= 1) return false;
  try {
    process.kill(-pid!, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function stopCommandGroup(child: ChildProcess, isClosed: () => boolean): Promise<boolean> {
  if (!child.pid) return true;
  for (const [signal, graceMs] of [["SIGTERM", 250], ["SIGKILL", 1000]] as const) {
    if (commandGroupExists(child.pid)) {
      try { process.kill(-child.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
    }
    const deadline = performance.now() + graceMs;
    while (performance.now() < deadline) {
      if (isClosed() && !commandGroupExists(child.pid)) return true;
      await delay(20);
    }
  }
  return isClosed() && !commandGroupExists(child.pid);
}
