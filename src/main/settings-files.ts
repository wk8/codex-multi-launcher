import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface FileSnapshot {
  path: string;
  text: string | null;
  mode: number;
  fingerprint: string;
}

export interface FileChange {
  before: FileSnapshot;
  after: string;
}

interface JournalEntry {
  path: string;
  beforeHash: string;
  afterHash: string;
  existed: boolean;
  mode: number;
  backup: string;
}

interface Journal {
  schemaVersion: 1;
  state: "pending" | "committed" | "restored";
  entries: JournalEntry[];
}

export interface TransactionIO {
  replace(filePath: string, text: string, mode: number): Promise<void>;
  remove(filePath: string): Promise<void>;
}

const defaultIO: TransactionIO = {
  replace: atomicWriteText,
  remove: (filePath) => fs.unlink(filePath)
};

export async function readSettingsFile(filePath: string, limit = 16 * 1024 * 1024): Promise<FileSnapshot> {
  let handle;
  try {
    const link = await fs.lstat(filePath);
    if (!link.isFile() || link.isSymbolicLink()) throw new Error(`Expected a regular file, not a link or directory: ${filePath}`);
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error(`File is not regular or exceeds ${limit} bytes: ${filePath}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (stamp(before) !== stamp(after) || before.ino !== link.ino || bytes.length > limit) {
      throw new Error(`File changed while being read: ${filePath}`);
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { path: filePath, text, mode: before.mode & 0o777, fingerprint: `${stamp(before)}:${hash(text)}` };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { path: filePath, text: null, mode: 0o600, fingerprint: "missing" };
    throw error;
  } finally {
    await handle?.close();
  }
}

function stamp(stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; mode: number }): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(":");
}

export async function assertUnchanged(snapshots: FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    const current = await readSettingsFile(snapshot.path);
    if (current.fingerprint !== snapshot.fingerprint) {
      throw new Error(`File changed since preparation; retry without editing it concurrently: ${snapshot.path}`);
    }
  }
}

export async function atomicWriteText(filePath: string, text: string, mode = 0o600): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", mode);
    try {
      await handle.chmod(mode);
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function applyFileChanges(
  changes: FileChange[],
  backupRoot: string,
  beforeWrite: () => Promise<void>,
  io: TransactionIO = defaultIO,
  beforeRecovery: () => Promise<void> = async () => undefined
): Promise<string | undefined> {
  const changed = changes.filter((change) => change.before.text !== change.after);
  if (!changed.length) return undefined;
  await beforeWrite();
  await assertUnchanged(changes.map((change) => change.before));

  const backupPath = path.join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  await fs.mkdir(backupPath, { recursive: true, mode: 0o700 });
  const journal: Journal = { schemaVersion: 1, state: "pending", entries: [] };
  for (const [index, change] of changed.entries()) {
    const backup = `${index}.original`;
    if (change.before.text !== null) await atomicWriteText(path.join(backupPath, backup), change.before.text);
    journal.entries.push({
      path: change.before.path, beforeHash: hash(change.before.text), afterHash: hash(change.after),
      existed: change.before.text !== null, mode: change.before.mode, backup
    });
  }
  const journalPath = path.join(backupPath, "transaction.json");
  await saveJournal(journalPath, journal);

  try {
    const remaining = [...changes];
    for (const change of changed) {
      await beforeWrite();
      await assertUnchanged(remaining.map((item) => item.before));
      await io.replace(change.before.path, change.after, change.before.mode);
      remaining.splice(remaining.indexOf(change), 1);
    }
    journal.state = "committed";
    await saveJournal(journalPath, journal);
    return backupPath;
  } catch (error) {
    try {
      await restoreJournal(journal, backupPath, io, beforeRecovery);
      journal.state = "restored";
      await saveJournal(journalPath, journal);
    } catch (recoveryError) {
      throw new Error(`Defaults failed and recovery needs attention. Backups: ${backupPath}. ${errorText(error)} ${errorText(recoveryError)}`);
    }
    throw new Error(`Defaults were not applied; originals restored. Backups: ${backupPath}. ${errorText(error)}`);
  }
}

export async function pendingTransactions(backupRoot: string, allowedPaths: string[]): Promise<{ directory: string; journal: Journal }[]> {
  let directories;
  try {
    directories = await fs.readdir(backupRoot, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const pending = [];
  for (const directory of directories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!directory.isDirectory()) throw new Error(`Unexpected entry in defaults backups: ${directory.name}`);
    const fullPath = path.join(backupRoot, directory.name);
    const snapshot = await readSettingsFile(path.join(fullPath, "transaction.json"), 1024 * 1024);
    // A crash before the journal is written cannot have replaced a profile file.
    if (snapshot.text === null) continue;
    const journal = JSON.parse(snapshot.text) as Journal;
    if (journal.schemaVersion !== 1 || !["pending", "committed", "restored"].includes(journal.state)
      || !Array.isArray(journal.entries) || journal.entries.length > allowedPaths.length
      || new Set(journal.entries.map((entry) => entry.path)).size !== journal.entries.length
      || journal.entries.some((entry, index) => !allowedPaths.includes(entry.path)
        || entry.backup !== `${index}.original` || typeof entry.existed !== "boolean"
        || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
        || !/^[a-f0-9]{64}$/.test(entry.beforeHash) || !/^[a-f0-9]{64}$/.test(entry.afterHash))) {
      throw new Error(`Invalid defaults recovery journal: ${fullPath}`);
    }
    if (journal.state === "pending") pending.push({ directory: fullPath, journal });
  }
  return pending;
}

export async function recoverFileChanges(backupRoot: string, allowedPaths: string[], beforeWrite: () => Promise<void>): Promise<void> {
  for (const { directory, journal } of await pendingTransactions(backupRoot, allowedPaths)) {
    await beforeWrite();
    await restoreJournal(journal, directory, defaultIO, beforeWrite);
    journal.state = "restored";
    await saveJournal(path.join(directory, "transaction.json"), journal);
  }
}

async function restoreJournal(
  journal: Journal, directory: string, io: TransactionIO, beforeWrite: () => Promise<void> = async () => undefined
): Promise<void> {
  const originals = await Promise.all(journal.entries.map(async (entry) => {
    const current = await readSettingsFile(entry.path);
    const currentHash = hash(current.text);
    if (currentHash !== entry.beforeHash && currentHash !== entry.afterHash) {
      throw new Error(`Refusing to overwrite an external edit during recovery: ${entry.path}`);
    }
    const original = entry.existed ? await readSettingsFile(path.join(directory, entry.backup)) : null;
    if (hash(original?.text ?? null) !== entry.beforeHash) throw new Error(`Backup is missing or modified: ${directory}/${entry.backup}`);
    return { entry, current, original };
  }));

  for (const { entry, current, original } of originals.reverse()) {
    if (hash(current.text) === entry.beforeHash) continue;
    await beforeWrite();
    await assertUnchanged([current]);
    if (entry.existed) await io.replace(entry.path, original!.text!, entry.mode);
    else await io.remove(entry.path);
  }
}

function saveJournal(filePath: string, journal: Journal): Promise<void> {
  return atomicWriteText(filePath, JSON.stringify(journal, null, 2) + "\n");
}

function hash(text: string | null): string {
  return createHash("sha256").update(text === null ? "missing" : `present:${text}`).digest("hex");
}

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
