import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const directory of ["dist", "dist-electron"]) {
  await fs.rm(path.join(projectRoot, directory), { force: true, recursive: true });
}
