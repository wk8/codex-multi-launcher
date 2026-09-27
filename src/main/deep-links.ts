import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { codexExecutablePath, resolveCodexDesktopApp } from "./paths.js";
import type { ManagedProfile } from "../shared/types.js";

const execFileAsync = promisify(execFile);
export const CODEX_LINK_PROTOCOL = "codex";

export interface DesktopLinkTarget {
  pid: number;
  name: string;
  profileId: string | null;
  executablePath: string;
  userDataDir: string | null;
}

export interface DesktopProcess {
  pid: number;
  command: string;
}

export function validateCodexLink(value: unknown): string {
  if (typeof value !== "string" || value.length > 65536 || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Use a valid codex:// browser return link.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Use a valid codex:// browser return link.");
  }
  if (!value.startsWith("codex://") || url.protocol !== "codex:" || !url.hostname || url.username || url.password || url.port) {
    throw new Error("Use a valid codex:// browser return link.");
  }
  return value;
}

export async function readDesktopProcesses(): Promise<DesktopProcess[]> {
  const { stdout } = await execFileAsync("/bin/ps", ["axo", "pid=,command="], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}

export function matchDesktopLinkTargets(
  profiles: ManagedProfile[],
  processes: DesktopProcess[],
  defaultExecutable = resolveCodexDesktopApp().executablePath
): DesktopLinkTarget[] {
  const activeProfiles = profiles.filter((profile) => profile.status === "active");
  const executables = new Set([defaultExecutable, ...activeProfiles.map((profile) => codexExecutablePath(profile.paths.codexAppPath))]);
  return processes.flatMap((process) => {
    const executablePath = [...executables].find((executable) => process.command === executable || process.command.startsWith(`${executable} `));
    if (!executablePath) return [];
    const args = process.command.slice(executablePath.length);
    const profile = activeProfiles.find((candidate) => {
      if (codexExecutablePath(candidate.paths.codexAppPath) !== executablePath) return false;
      // ps does not quote spaces in paths. Match the full configured value and
      // its argument boundary, never a profile prefix or a Chromium helper.
      const argument = ` --user-data-dir=${candidate.paths.userDataDir}`;
      const offset = args.indexOf(argument);
      const remainder = args.slice(offset + argument.length);
      return offset >= 0 && (remainder === "" || remainder.startsWith(" --"));
    });
    if (!profile && /(?:^|\s)--user-data-dir(?:=|\s)/.test(args)) return [];
    return [{
      pid: process.pid,
      name: profile ? `Personal: ${profile.name}` : "Main app",
      profileId: profile?.id ?? null,
      executablePath,
      userDataDir: profile?.paths.userDataDir ?? null
    }];
  });
}

export async function listDesktopLinkTargets(profiles: ManagedProfile[]): Promise<DesktopLinkTarget[]> {
  return matchDesktopLinkTargets(profiles, await readDesktopProcesses());
}

export async function restoreBrowserLinkHandler(
  client: {
    isDefaultProtocolClient(protocol: string): boolean;
    setAsDefaultProtocolClient(protocol: string): boolean;
  },
  getTargets: () => Promise<DesktopLinkTarget[]>
): Promise<boolean> {
  if (client.isDefaultProtocolClient(CODEX_LINK_PROTOCOL)) return true;
  const targets = await getTargets();
  if (!targets.some((target) => target.profileId !== null)) return false;

  // The official app registers itself on startup, including profile launches.
  // Keep the chooser available while an isolated profile needs return links.
  client.setAsDefaultProtocolClient(CODEX_LINK_PROTOCOL);
  return client.isDefaultProtocolClient(CODEX_LINK_PROTOCOL);
}

export function sameDesktopTarget(left: DesktopLinkTarget, right: DesktopLinkTarget): boolean {
  return left.pid === right.pid && left.profileId === right.profileId
    && left.executablePath === right.executablePath && left.userDataDir === right.userDataDir;
}

// Send the standard macOS Get URL event to a PID, not to a bundle identifier
// shared by all profiles. The callback travels over stdin, never shell text,
// command-line arguments, or a temporary file.
const SEND_URL_SCRIPT = String.raw`
ObjC.import("AppKit");
function run() {
  var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var request = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
  var target = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
  if (!target || target.isTerminated || ObjC.unwrap(target.executableURL.path) !== request.executablePath) {
    throw new Error("The selected app is no longer running.");
  }
  var address = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(request.pid);
  var event = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
    0x4755524c, 0x4755524c, address, -1, 0
  );
  event.setParamDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithString(request.url), 0x2d2d2d2d);
  var error = Ref();
  event.sendEventWithOptionsTimeoutError(3, 10, error);
  if (ObjC.unwrap(error[0]) != null) throw new Error("The selected app did not accept the browser link.");
  target.activateWithOptions(2);
}
`;

export async function sendCodexLinkToTarget(target: DesktopLinkTarget, value: string): Promise<void> {
  const url = validateCodexLink(value);
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0) throw new Error("The selected app is no longer running.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", SEND_URL_SCRIPT], {
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 15000
    });
    const fail = () => reject(new Error("Could not deliver the browser link. Keep the originating app open and try connecting again."));
    child.once("error", fail);
    child.stdin.once("error", fail);
    child.once("close", (code) => code === 0 ? resolve() : fail());
    child.stdin.end(JSON.stringify({ pid: target.pid, executablePath: target.executablePath, url }));
  });
}
