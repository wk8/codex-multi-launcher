import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir } from "./fs-utils.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export async function generateProfileIcon(iconPath: string, _backgroundColor: string): Promise<void> {
  await ensureDir(path.dirname(iconPath));
  // Read ASAR bytes directly; copyFile can reuse a deleted temporary extraction.
  const icon = await fs.readFile(await resolveBundledIcon());
  await fs.writeFile(iconPath, icon, { mode: 0o600 });
  await fs.chmod(iconPath, 0o600);
}

async function resolveBundledIcon(): Promise<string> {
  const candidates = [
    path.resolve(moduleDirectory, "../../assets/app.icns"),
    path.join(process.resourcesPath ?? "", "app.asar", "assets", "app.icns"),
    path.join(process.resourcesPath ?? "", "app", "assets", "app.icns"),
    path.resolve(process.cwd(), "assets", "app.icns")
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next supported development or packaged layout.
    }
  }
  throw new Error(`assets/app.icns not found. Checked: ${candidates.join(", ")}`);
}
