export type ProfileStatus = "active" | "deleted";

export type RuntimeStatus = "running" | "not_running" | "unknown";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type PreparationEvent = "create" | "startup" | "launch";

export interface PreparationMessage {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  details?: string;
}

export interface SettingChange {
  filePath: string;
  path: string[];
  before: string | null;
  after: string;
}

export interface PreparationResult {
  profileId: string;
  event: PreparationEvent;
  checkedAt: string;
  status: "disabled" | "ready" | "warning" | "blocked" | "deferred";
  messages: PreparationMessage[];
  changedFiles: string[];
  backupPath?: string;
  setupPending?: boolean;
  invocationId?: string;
  command?: CommandDiagnostics;
  acknowledgedWarnings?: string[];
  newWarningCodes?: string[];
}

export interface CommandDiagnostics {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stderr: string;
  stderrTruncated: boolean;
  processGroupId: number | null;
  cleanupPending: boolean;
}

export interface OpenProfileResult {
  pid: number | null;
  preparation: PreparationResult;
}

export interface PreparationPreview {
  policyFile: string;
  status: PreparationResult["status"];
  messages: PreparationMessage[];
  changes: SettingChange[];
  command?: { executable: string; args: string[]; cwd: string; status: "not-run" };
}

export interface AppPaths {
  appDataDir: string;
  profilesFile: string;
  defaultProfileRoot: string;
  defaultUserDataRoot: string;
  defaultLauncherRoot: string;
}

export interface EnvironmentCheck {
  id: string;
  label: string;
  status: "pass" | "fail";
  detail: string;
  path: string;
}

export interface EnvironmentReport {
  codexAppPath: string;
  codexExecutablePath: string;
  codexAppExists: boolean;
  codexExecutableExists: boolean;
  checks: EnvironmentCheck[];
}

export interface ProfilePaths {
  codexAppPath: string;
  homeDir: string;
  codexHome: string;
  userDataDir: string;
  launcherPath: string;
}

export interface ProfileAppearance {
  iconBackgroundColor: string;
}

export interface ManagedProfile {
  id: string;
  name: string;
  status: ProfileStatus;
  paths: ProfilePaths;
  auth: {
    mode: "chatgpt_account";
  };
  appearance: ProfileAppearance;
  launch: {
    lastLaunchedAt: string | null;
    lastKnownPid: number | null;
    lastKnownUserDataDir: string;
  };
  timestamps: {
    createdAt: string;
    updatedAt: string;
  };
}

export interface ProfileRegistry {
  schemaVersion: 1;
  profiles: ManagedProfile[];
}

export interface CreateProfileInput {
  name: string;
  codexAppPath?: string;
  appearance?: Partial<ProfileAppearance>;
}

export interface CreateProfileResult {
  profile: ManagedProfile;
  configPath: string;
  launcherPath: string;
  preparation: PreparationResult;
}

export interface ProfileRuntimeInfo {
  profileId: string;
  status: RuntimeStatus;
  pid: number | null;
  detail: string;
}

export interface LauncherResult {
  launcherPath: string;
  executablePath: string;
}

export interface AppInfo {
  name: string;
  version: string;
  buildKind: "local-personal";
}

export interface CodexApi {
  getAppInfo(): Promise<AppInfo>;
  getBrowserLinkStatus(): Promise<boolean>;
  enableBrowserLinks(): Promise<boolean>;
  getEnvironmentReport(codexAppPath?: string): Promise<EnvironmentReport>;
  pickCodexAppPath(): Promise<string | null>;
  listProfiles(): Promise<ManagedProfile[]>;
  getRuntimeStatus(): Promise<ProfileRuntimeInfo[]>;
  getPreparationResults(): Promise<PreparationResult[]>;
  previewProfileDefaults(profileId: string): Promise<PreparationPreview>;
  retryProfilePreparation(profileId: string): Promise<PreparationResult>;
  acknowledgeProfileWarnings(profileId: string): Promise<PreparationResult>;
  createProfile(input: CreateProfileInput): Promise<CreateProfileResult>;
  permanentlyDeleteProfile(profileId: string): Promise<{ ok: true }>;
  generateLauncher(profileId: string): Promise<LauncherResult>;
  revealLauncher(profileId: string): Promise<{ ok: true }>;
  openProfile(profileId: string): Promise<OpenProfileResult>;
}
