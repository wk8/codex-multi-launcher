import { matchDesktopLinkTargets, readDesktopProcesses, type DesktopProcess } from "./deep-links.js";
import type { ManagedProfile, ProfileRuntimeInfo } from "../shared/types.js";

export async function getRuntimeStatus(profiles: ManagedProfile[]): Promise<ProfileRuntimeInfo[]> {
  let processes: DesktopProcess[];
  try {
    processes = await readDesktopProcesses();
  } catch (error) {
    return profiles.map((profile) => ({
      profileId: profile.id,
      status: "unknown",
      pid: null,
      detail: error instanceof Error ? error.message : "Could not inspect the process list."
    }));
  }

  const targets = matchDesktopLinkTargets(profiles, processes);
  return profiles.map((profile) => {
    const process = targets.find((target) => target.profileId === profile.id);
    return process
      ? { profileId: profile.id, status: "running", pid: process.pid, detail: "Matched the isolated user-data directory." }
      : { profileId: profile.id, status: "not_running", pid: null, detail: "No matching desktop process was found." };
  });
}
