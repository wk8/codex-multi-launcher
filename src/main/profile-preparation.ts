import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ManagedProfile, PreparationEvent, PreparationMessage, PreparationPreview,
  PreparationResult, ProfileRuntimeInfo, SettingChange
} from "../shared/types.js";
import { parseDefaultsPolicy, type DefaultsPolicy } from "./defaults-policy.js";
import { editJsonSettings, editTomlSettings } from "./settings-edit.js";
import {
  applyFileChanges, assertUnchanged, atomicWriteText, errorText, pendingTransactions,
  readSettingsFile, recoverFileChanges, type FileChange, type FileSnapshot
} from "./settings-files.js";

export interface PreparationHost {
  dataDir: string;
  inspect(profile: ManagedProfile): Promise<ProfileRuntimeInfo>;
  assertStorage(profile: ManagedProfile): Promise<void>;
}

interface DefaultsPlan {
  files: FileChange[];
  changes: SettingChange[];
}

export class ProfilePreparation {
  readonly policyFile: string;

  constructor(private readonly host: PreparationHost) {
    this.policyFile = path.join(host.dataDir, "profile-defaults.json");
  }

  async preview(profile: ManagedProfile): Promise<PreparationPreview> {
    try {
      const { policy } = await this.loadPolicy();
      const previous = await this.readResult(profile.id);
      if ((await pendingTransactions(this.backupRoot(profile.id), this.profileFiles(profile))).length) {
        throw new Error("An interrupted defaults update needs recovery. Close the profile and choose Retry setup.");
      }
      if (!this.applies(policy, "startup", previous)) return this.previewResult("disabled");
      await this.host.assertStorage(profile);
      const plan = await this.plan(profile, policy!);
      const runtime = await this.host.inspect(profile);
      return this.previewResult(runtime.status === "not_running" ? "ready" : "deferred", plan.changes,
        runtime.status === "not_running" ? [] : [this.deferredMessage(runtime)]);
    } catch (error) {
      return this.previewResult("blocked", [], [failure(error)]);
    }
  }

  async prepare(profile: ManagedProfile, event: PreparationEvent): Promise<PreparationResult> {
    const result: PreparationResult = {
      profileId: profile.id, event, checkedAt: new Date().toISOString(), status: "ready", messages: [], changedFiles: []
    };
    let previous: PreparationResult | null = null;
    try {
      previous = await this.readResult(profile.id);
      const { snapshot, policy } = await this.loadPolicy();
      const applies = this.applies(policy, event, previous);
      const pending = await pendingTransactions(this.backupRoot(profile.id), this.profileFiles(profile));
      if (!applies && !pending.length) {
        result.status = "disabled";
        if (previous) await this.saveResult(result);
        return result;
      }

      const runtime = await this.host.inspect(profile);
      if (runtime.status !== "not_running") {
        result.status = "deferred";
        result.messages = [this.deferredMessage(runtime)];
      } else {
        const ensureStopped = async () => {
          await this.host.assertStorage(profile);
          if ((await this.host.inspect(profile)).status !== "not_running") {
            throw new Error("Profile started or its runtime became unknown during preparation. Close it and retry.");
          }
        };
        await ensureStopped();
        await recoverFileChanges(this.backupRoot(profile.id), this.profileFiles(profile), ensureStopped);
        if (applies) {
          const plan = await this.plan(profile, policy!);
          result.backupPath = await applyFileChanges(plan.files, this.backupRoot(profile.id), async () => {
            await ensureStopped();
            await assertUnchanged([snapshot]);
          }, undefined, ensureStopped);
          result.changedFiles = plan.files.filter((file) => file.before.text !== file.after).map((file) => file.before.path);
        } else {
          result.status = "disabled";
        }
      }
    } catch (error) {
      result.status = "blocked";
      result.messages = [failure(error)];
    }

    result.setupPending = (event === "create" || Boolean(previous?.setupPending))
      && (result.status === "blocked" || result.status === "deferred");
    await this.saveResult(result);
    return result;
  }

  async readResult(profileId: string): Promise<PreparationResult | null> {
    const snapshot = await readSettingsFile(this.resultFile(profileId), 256 * 1024);
    if (snapshot.text === null) return null;
    const result = JSON.parse(snapshot.text) as PreparationResult;
    if (!result || result.profileId !== profileId || !["create", "startup", "launch"].includes(result.event)
      || !["disabled", "ready", "warning", "blocked", "deferred"].includes(result.status)
      || !Array.isArray(result.messages) || !Array.isArray(result.changedFiles)
      || result.messages.some((message) => !message || !["info", "warning", "error"].includes(message.severity)
        || typeof message.code !== "string" || typeof message.message !== "string"
        || (message.details !== undefined && typeof message.details !== "string"))) {
      throw new Error(`Invalid preparation result: ${this.resultFile(profileId)}`);
    }
    return result;
  }

  async forget(profileId: string): Promise<void> {
    await fs.rm(this.resultFile(profileId), { force: true });
  }

  async recordFailure(profile: ManagedProfile, event: PreparationEvent, error: unknown): Promise<PreparationResult> {
    const result: PreparationResult = {
      profileId: profile.id, event, checkedAt: new Date().toISOString(), status: "blocked",
      messages: [failure(error)], changedFiles: []
    };
    await this.saveResult(result);
    return result;
  }

  private async loadPolicy(): Promise<{ snapshot: FileSnapshot; policy: DefaultsPolicy | null }> {
    const snapshot = await readSettingsFile(this.policyFile, 1024 * 1024);
    return { snapshot, policy: snapshot.text === null ? null : parseDefaultsPolicy(snapshot.text) };
  }

  private applies(policy: DefaultsPolicy | null, event: PreparationEvent, previous: PreparationResult | null): boolean {
    return Boolean(policy?.enabled && (policy.scope === "all-managed-profiles" || event === "create" || previous?.setupPending));
  }

  private async plan(profile: ManagedProfile, policy: DefaultsPolicy): Promise<DefaultsPlan> {
    const files: FileChange[] = [];
    const changes: SettingChange[] = [];
    for (const [filePath, settings, edit] of [
      [this.profileFiles(profile)[0], policy.config, editTomlSettings],
      [this.profileFiles(profile)[1], policy.desktopState, editJsonSettings]
    ] as const) {
      if (!settings.length) continue;
      const before = await readSettingsFile(filePath);
      const edited = edit(before.text, settings, policy.mode);
      files.push({ before, after: edited.changes.length ? edited.text : before.text ?? edited.text });
      changes.push(...edited.changes.map((change) => ({ ...change, filePath })));
    }
    return { files, changes };
  }

  private profileFiles(profile: ManagedProfile): string[] {
    return [path.join(profile.paths.codexHome, "config.toml"), path.join(profile.paths.codexHome, ".codex-global-state.json")];
  }

  private backupRoot(profileId: string): string {
    return path.join(this.host.dataDir, "profile-defaults-backups", storageKey(profileId));
  }

  private resultFile(profileId: string): string {
    return path.join(this.host.dataDir, "profile-preparation", `${storageKey(profileId)}.json`);
  }

  private async saveResult(result: PreparationResult): Promise<void> {
    await fs.mkdir(path.dirname(this.resultFile(result.profileId)), { recursive: true, mode: 0o700 });
    await atomicWriteText(this.resultFile(result.profileId), JSON.stringify(result, null, 2) + "\n");
  }

  private deferredMessage(runtime: ProfileRuntimeInfo): PreparationMessage {
    return {
      severity: "warning", code: "PROFILE_NOT_STOPPED",
      message: runtime.status === "running" ? "Setup pending: close this profile, then retry." : "Setup pending: the launcher cannot determine whether this profile is running.",
      details: runtime.detail
    };
  }

  private previewResult(status: PreparationPreview["status"], changes: SettingChange[] = [], messages: PreparationMessage[] = []): PreparationPreview {
    return { policyFile: this.policyFile, status, changes, messages };
  }
}

function storageKey(profileId: string): string {
  return createHash("sha256").update(profileId).digest("hex");
}

function failure(error: unknown): PreparationMessage {
  return { severity: "error", code: "PREPARATION_FAILED", message: errorText(error) };
}
