import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "./fs-utils.js";
import { generateProfileIcon } from "./icon-generator.js";
import type { LauncherResult, ManagedProfile } from "../shared/types.js";

function plist(profile: ManagedProfile): string {
  const name = escapeXml(profile.name);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${name}</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIconFile</key>
  <string>profile-icon</string>
  <key>CFBundleIdentifier</key>
  <string>local.wk.codexpersonal.${profile.id}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${name}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function launcherScript(profile: ManagedProfile): string {
  const manager = managerLaunchCommand();
  const managerArgs = manager.args.map(shellQuote).join(" ");
  const logPath = path.join(profile.paths.codexHome, "logs", "launcher.log");
  return `#!/bin/zsh
set -euo pipefail

LOG_FILE=${shellQuote(logPath)}
mkdir -p "$(dirname "$LOG_FILE")"

if [[ "\${CODEX_PERSONAL_LAUNCH:-}" == "1" ]]; then
  if [[ -z "\${CHATGPT_EXE:-}" || -z "\${HOME:-}" || -z "\${CODEX_HOME:-}" || -z "\${CODEX_PERSONAL_HOME:-}" || -z "\${USER_DATA_DIR:-}" ]]; then
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] missing isolated launch environment" >> "$LOG_FILE"
    exit 2
  fi
  if [[ "$HOME" != "$CODEX_PERSONAL_HOME" || "$CODEX_HOME" != "$HOME/codex-home" ]]; then
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] HOME and CODEX_HOME are not the isolated profile paths" >> "$LOG_FILE"
    exit 3
  fi
  mkdir -p "$HOME/.agents/skills" "$CODEX_HOME/skills" "$USER_DATA_DIR"
  exec "$CHATGPT_EXE" --user-data-dir="$USER_DATA_DIR" >> "$LOG_FILE" 2>&1
fi

exec ${shellQuote(manager.executablePath)} ${managerArgs} ${shellQuote(`--open-profile=${profile.id}`)} >> "$LOG_FILE" 2>&1
`;
}

function managerLaunchCommand(): { executablePath: string; args: string[] } {
  const defaultApp = Boolean((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp);
  if (!defaultApp) return { executablePath: process.execPath, args: [] };
  const appPathArg = process.argv[1] && !process.argv[1].startsWith("--") ? process.argv[1] : process.cwd();
  return {
    executablePath: process.execPath,
    args: [path.resolve(process.cwd(), appPathArg)]
  };
}

export async function generateLauncher(profile: ManagedProfile): Promise<LauncherResult> {
  const contentsDir = path.join(profile.paths.launcherPath, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");
  const executablePath = path.join(macosDir, "launcher");
  await Promise.all([ensureDir(macosDir), ensureDir(resourcesDir)]);
  await fs.writeFile(path.join(contentsDir, "Info.plist"), plist(profile), { mode: 0o644 });
  await fs.writeFile(executablePath, launcherScript(profile), { mode: 0o700 });
  await generateProfileIcon(path.join(resourcesDir, "profile-icon.icns"), profile.appearance.iconBackgroundColor);
  return { launcherPath: profile.paths.launcherPath, executablePath };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
