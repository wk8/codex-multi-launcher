import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppInfo,
  EnvironmentReport,
  ManagedProfile,
  PreparationPreview,
  PreparationResult,
  ProfileRuntimeInfo
} from "../shared/types";
import { PreparationFeedback } from "./PreparationFeedback";
import { newWarnings } from "../shared/preparation-feedback";

const PROFILE_COLORS = ["#34C759", "#007AFF", "#AF52DE", "#FF9500", "#FF2D55", "#00A6A6"];

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [environment, setEnvironment] = useState<EnvironmentReport | null>(null);
  const [profiles, setProfiles] = useState<ManagedProfile[]>([]);
  const [runtime, setRuntime] = useState<ProfileRuntimeInfo[]>([]);
  const [preparation, setPreparation] = useState<PreparationResult[]>([]);
  const [preview, setPreview] = useState<PreparationPreview | null>(null);
  const [notice, setNotice] = useState<{ profileId: string; text: string } | null>(null);
  const [browserLinksEnabled, setBrowserLinksEnabled] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [profileName, setProfileName] = useState("Personal");
  const [appPath, setAppPath] = useState("");
  const [color, setColor] = useState(PROFILE_COLORS[0]);
  const [busy, setBusy] = useState<string | null>("loading");
  const [error, setError] = useState<string | null>(null);

  const refreshProfiles = useCallback(async () => {
    const [nextProfiles, nextRuntime, nextPreparation] = await Promise.all([
      window.codexProfileManager.listProfiles(),
      window.codexProfileManager.getRuntimeStatus(),
      window.codexProfileManager.getPreparationResults()
    ]);
    setProfiles(nextProfiles);
    setRuntime(nextRuntime);
    setPreparation(nextPreparation);
  }, []);

  const refreshEnvironment = useCallback(async (candidate?: string) => {
    const nextEnvironment = await window.codexProfileManager.getEnvironmentReport(candidate);
    setEnvironment(nextEnvironment);
    setAppPath(nextEnvironment.codexAppPath);
  }, []);

  useEffect(() => {
    void Promise.all([
      window.codexProfileManager.getAppInfo().then(setAppInfo),
      window.codexProfileManager.getBrowserLinkStatus().then(setBrowserLinksEnabled),
      refreshEnvironment(),
      refreshProfiles()
    ]).catch((reason) => setError(errorMessage(reason))).finally(() => setBusy(null));
  }, [refreshEnvironment, refreshProfiles]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void window.codexProfileManager.getRuntimeStatus().then(setRuntime).catch(() => undefined);
      void window.codexProfileManager.getPreparationResults().then(setPreparation).catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const refreshBrowserLinks = () => {
      void window.codexProfileManager.getBrowserLinkStatus().then(setBrowserLinksEnabled).catch(() => undefined);
    };
    window.addEventListener("focus", refreshBrowserLinks);
    return () => window.removeEventListener("focus", refreshBrowserLinks);
  }, []);

  async function enableBrowserLinks() {
    setBusy("browser-links");
    setError(null);
    try {
      const enabled = await window.codexProfileManager.enableBrowserLinks();
      setBrowserLinksEnabled(enabled);
      if (!enabled) setError("macOS did not switch the browser link handler. Try again and accept any system prompt.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  const runtimeByProfile = useMemo(
    () => new Map(runtime.map((item) => [item.profileId, item])),
    [runtime]
  );
  const preparationByProfile = useMemo(() => new Map(preparation.map((item) => [item.profileId, item])), [preparation]);
  const setupBlocked = preparation.filter((item) => item.status === "blocked").length;
  const setupPending = preparation.filter((item) => item.status === "deferred").length;
  const setupWarnings = preparation.filter((item) => item.status === "warning").length;

  async function chooseDesktopApp() {
    const selected = await window.codexProfileManager.pickCodexAppPath();
    if (!selected) return;
    setBusy("environment");
    setError(null);
    try {
      await refreshEnvironment(selected);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function createPersonalProfile() {
    setBusy("create");
    setError(null);
    try {
      const result = await window.codexProfileManager.createProfile({
        name: profileName,
        codexAppPath: appPath,
        appearance: { iconBackgroundColor: color }
      });
      showPreparationFeedback(result.preparation);
      await refreshProfiles();
      setShowCreate(false);
      setProfileName("Personal");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function runProfileAction(profileId: string, action: () => Promise<unknown>) {
    setBusy(profileId);
    setError(null);
    try {
      const value = await action();
      if (value && typeof value === "object") {
        if ("preparation" in value) showPreparationFeedback(value.preparation as PreparationResult);
        else if ("checkedAt" in value && "messages" in value) showPreparationFeedback(value as PreparationResult);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      await refreshProfiles().catch((reason) => setError(errorMessage(reason)));
      setBusy(null);
    }
  }

  function showPreparationFeedback(result: PreparationResult) {
    if (result.status === "blocked") setError(result.messages.filter((message) => message.severity === "error").map((message) => message.message).join("\n"));
    const warnings = newWarnings(result);
    if (warnings.length) setNotice({ profileId: result.profileId, text: warnings.map((message) => message.message).join("\n") });
    else setNotice((current) => current?.profileId === result.profileId ? null : current);
  }

  async function acknowledgeWarnings(profileId: string) {
    await runProfileAction(profileId, () => window.codexProfileManager.acknowledgeProfileWarnings(profileId));
  }

  async function deleteProfile(profile: ManagedProfile) {
    const confirmed = window.confirm(
      `Permanently delete “${profile.name}”?\n\nThis removes its personal chats and local session data from this Mac.`
    );
    if (!confirmed) return;
    await runProfileAction(profile.id, () => window.codexProfileManager.permanentlyDeleteProfile(profile.id));
  }

  const environmentReady = Boolean(environment?.codexAppExists && environment.codexExecutableExists);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">LOCAL PERSONAL BUILD</p>
          <h1>Codex Personal Launcher</h1>
          <p className="subtitle">A clean ChatGPT-account profile beside your existing work app.</p>
        </div>
        <button className="primary" onClick={() => setShowCreate(true)} disabled={Boolean(busy)}>
          New personal profile
        </button>
      </header>

      <section className="privacy-card">
        <span className="shield" aria-hidden="true">✓</span>
        <div>
          <strong>Isolation is enforced by this build</strong>
          <p>
            Every profile starts empty with dedicated HOME, CODEX_HOME, skills, and browser-data directories.
            Work settings, chats, plugins, skills, credentials, and environment variables are never imported.
            Any profile defaults you configure are applied during setup.
          </p>
        </div>
        <span className="offline-badge">No launcher telemetry</span>
      </section>

      {error ? (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      ) : null}

      {notice ? <div className="setup-summary notice" role="status"><span>{notice.text}</span>
        <button className="secondary" disabled={Boolean(busy)} onClick={() => void acknowledgeWarnings(notice.profileId)}>Acknowledge</button>
      </div> : null}

      {setupBlocked || setupPending || setupWarnings ? (
        <div className="setup-summary" role="status">
          Profile setup: {setupBlocked} blocked · {setupPending} pending · {setupWarnings} with warnings.
          Review the affected profiles below.
        </div>
      ) : null}

      <section className="environment-card">
        <div>
          <p className="section-label">OFFICIAL DESKTOP APP</p>
          <strong>{environmentReady ? "Ready" : "Needs attention"}</strong>
          <code>{appPath || "No app selected"}</code>
        </div>
        <button className="secondary" onClick={() => void chooseDesktopApp()} disabled={Boolean(busy)}>
          Choose app…
        </button>
      </section>

      <section className="environment-card browser-links-card">
        <div>
          <p className="section-label">BROWSER RETURN LINKS</p>
          <strong>{browserLinksEnabled ? "Choose a profile when the browser returns" : "Browser links may open the main app"}</strong>
          <p className="subtitle">
            Connect an app, then choose the main or personal window that started the connection.
            The launcher keeps browser links working while a personal profile is open,
            even when this window is closed. Quitting the launcher stops this protection.
          </p>
        </div>
        <button className="secondary" onClick={() => void enableBrowserLinks()} disabled={Boolean(busy)}>
          Use launcher for browser links
        </button>
      </section>

      <section className="profiles-section">
        <div className="section-heading">
          <div>
            <p className="section-label">PERSONAL PROFILES</p>
            <h2>{profiles.length ? `${profiles.length} isolated profile${profiles.length === 1 ? "" : "s"}` : "No profiles yet"}</h2>
          </div>
          <button className="text-button" onClick={() => void refreshProfiles()} disabled={Boolean(busy)}>
            Refresh
          </button>
        </div>

        {profiles.length ? (
          <div className="profile-grid">
            {profiles.map((profile) => {
              const status = runtimeByProfile.get(profile.id);
              const running = status?.status === "running";
              return (
                <article className="profile-card" key={profile.id}>
                  <div className="profile-title-row">
                    <span className="profile-icon" style={{ backgroundColor: profile.appearance.iconBackgroundColor }}>
                      {profile.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <h3>{profile.name}</h3>
                      <p>ChatGPT account login</p>
                    </div>
                    <span className={`status ${running ? "running" : "stopped"}`}>
                      {running ? "Running" : status?.status === "not_running" ? "Not running" : "Runtime unknown"}
                    </span>
                  </div>

                  <dl className="path-list">
                    <div>
                      <dt>Personal HOME</dt>
                      <dd>{profile.paths.homeDir}</dd>
                    </div>
                    <div>
                      <dt>CODEX_HOME</dt>
                      <dd>{profile.paths.codexHome}</dd>
                    </div>
                    <div>
                      <dt>User skills</dt>
                      <dd>{profile.paths.homeDir}/.agents/skills</dd>
                    </div>
                    <div>
                      <dt>Browser session</dt>
                      <dd>{profile.paths.userDataDir}</dd>
                    </div>
                  </dl>

                  <PreparationFeedback result={preparationByProfile.get(profile.id)} busy={Boolean(busy)}
                    onAcknowledge={() => void acknowledgeWarnings(profile.id)}
                    onRetry={() => void runProfileAction(profile.id, () => window.codexProfileManager.retryProfilePreparation(profile.id))} />

                  <div className="profile-actions">
                    <button
                      className="primary"
                      disabled={Boolean(busy)}
                      onClick={() => void runProfileAction(profile.id, () => window.codexProfileManager.openProfile(profile.id))}
                    >
                      {busy === profile.id ? "Working…" : "Open"}
                    </button>
                    <button
                      className="secondary"
                      disabled={Boolean(busy)}
                      onClick={() => void runProfileAction(profile.id, () => window.codexProfileManager.generateLauncher(profile.id))}
                    >
                      Rebuild shortcut
                    </button>
                    <button className="secondary" onClick={() => void window.codexProfileManager.revealLauncher(profile.id)}>
                      Show shortcut
                    </button>
                    <button className="secondary" disabled={Boolean(busy)} onClick={() => void runProfileAction(profile.id, async () => {
                      setPreview(await window.codexProfileManager.previewProfileDefaults(profile.id));
                    })}>
                      Preview defaults
                    </button>
                    <button className="danger" disabled={Boolean(busy)} onClick={() => void deleteProfile(profile)}>
                      Delete
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <span aria-hidden="true">◎</span>
            <h3>Create a personal profile</h3>
            <p>Its first launch will ask you to sign into your separate personal ChatGPT account.</p>
            <button className="primary" onClick={() => setShowCreate(true)} disabled={Boolean(busy)}>
              Create profile
            </button>
          </div>
        )}
      </section>

      <footer>
        <span>{appInfo ? `${appInfo.name} ${appInfo.version}` : "Local build"}</span>
        <span>No subscriptions · No announcements · No updater</span>
      </footer>

      {preview ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal defaults-preview" role="dialog" aria-modal="true" aria-labelledby="preview-title">
            <div className="modal-header"><h2 id="preview-title">Preview profile defaults</h2>
              <button className="close-button" onClick={() => setPreview(null)} aria-label="Close">×</button>
            </div>
            <p>This preview does not change files.</p>
            <code>{preview.policyFile}</code>
            {preview.command ? <details open><summary>Preparation command: not run</summary>
              <pre>{JSON.stringify([preview.command.executable, ...preview.command.args])}</pre>
              <p>Working directory: <code>{preview.command.cwd}</code></p>
            </details> : null}
            {preview.messages.map((message, index) => <p key={index}>{message.message}</p>)}
            {preview.status === "disabled" ? <p>No defaults apply to this existing profile.</p> : null}
            {preview.changes.length ? <div className="preview-table"><table>
              <thead><tr><th>File / setting path</th><th>Current</th><th>Default</th></tr></thead>
              <tbody>{preview.changes.map((change) => <tr key={`${change.filePath}:${JSON.stringify(change.path)}`}>
                <td><code>{change.filePath}</code><pre>{JSON.stringify(change.path)}</pre></td>
                <td><pre>{change.before ?? "(missing)"}</pre></td><td><pre>{change.after}</pre></td>
              </tr>)}</tbody>
            </table></div> : preview.status === "ready" ? <p>Settings already match.</p> : null}
          </section>
        </div>
      ) : null}

      {showCreate ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
            <div className="modal-header">
              <div>
                <p className="section-label">NEW ISOLATED PROFILE</p>
                <h2 id="create-title">Personal ChatGPT account</h2>
              </div>
              <button className="close-button" onClick={() => setShowCreate(false)} aria-label="Close">×</button>
            </div>

            <label>
              Profile name
              <input
                autoFocus
                maxLength={64}
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                placeholder="Personal"
              />
            </label>

            <label>
              Official desktop app
              <div className="input-action">
                <input value={appPath} readOnly />
                <button className="secondary" onClick={() => void chooseDesktopApp()}>Choose…</button>
              </div>
            </label>

            <fieldset>
              <legend>Shortcut color</legend>
              <div className="color-options">
                {PROFILE_COLORS.map((option) => (
                  <button
                    aria-label={`Use color ${option}`}
                    className={option === color ? "selected" : ""}
                    key={option}
                    onClick={() => setColor(option)}
                    style={{ backgroundColor: option }}
                    type="button"
                  />
                ))}
              </div>
            </fieldset>

            <div className="isolation-summary">
              <strong>Dedicated profile storage</strong>
              <p>No settings or account data are inherited from another profile. Your configured profile defaults are applied during setup.</p>
            </div>

            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowCreate(false)}>Cancel</button>
              <button
                className="primary"
                disabled={busy === "create" || !profileName.trim() || !environmentReady}
                onClick={() => void createPersonalProfile()}
              >
                {busy === "create" ? "Creating…" : "Create personal profile"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
