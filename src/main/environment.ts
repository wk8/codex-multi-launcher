import { getAppPaths, resolveCodexDesktopApp } from "./paths.js";
import { isWritableDirectory, pathExists } from "./fs-utils.js";
import type { EnvironmentCheck, EnvironmentReport } from "../shared/types.js";

export async function getEnvironmentReport(codexAppPath?: string): Promise<EnvironmentReport> {
  const appPaths = getAppPaths();
  const desktopApp = resolveCodexDesktopApp(codexAppPath);
  const [codexAppExists, codexExecutableExists, launcherWritable, profileWritable, userDataWritable] =
    await Promise.all([
      pathExists(desktopApp.appPath),
      pathExists(desktopApp.executablePath),
      isWritableDirectory(appPaths.defaultLauncherRoot),
      isWritableDirectory(appPaths.defaultProfileRoot),
      isWritableDirectory(appPaths.defaultUserDataRoot)
    ]);

  const checks: EnvironmentCheck[] = [
    {
      id: "chatgpt-app",
      label: "ChatGPT/Codex desktop app",
      status: codexAppExists && codexExecutableExists ? "pass" : "fail",
      detail: codexAppExists && codexExecutableExists
        ? "The official desktop executable was found."
        : "Select an installed ChatGPT or Codex app before creating a profile.",
      path: desktopApp.appPath
    },
    {
      id: "profile-root",
      label: "Personal profile storage",
      status: profileWritable ? "pass" : "fail",
      detail: profileWritable ? "The isolated CODEX_HOME root is writable." : "The isolated CODEX_HOME root is not writable.",
      path: appPaths.defaultProfileRoot
    },
    {
      id: "user-data-root",
      label: "Personal session storage",
      status: userDataWritable ? "pass" : "fail",
      detail: userDataWritable ? "The isolated browser-data root is writable." : "The isolated browser-data root is not writable.",
      path: appPaths.defaultUserDataRoot
    },
    {
      id: "launcher-root",
      label: "Personal launcher directory",
      status: launcherWritable ? "pass" : "fail",
      detail: launcherWritable ? "The launcher directory is writable." : "The launcher directory is not writable.",
      path: appPaths.defaultLauncherRoot
    }
  ];

  return {
    codexAppPath: desktopApp.appPath,
    codexExecutablePath: desktopApp.executablePath,
    codexAppExists,
    codexExecutableExists,
    checks
  };
}
