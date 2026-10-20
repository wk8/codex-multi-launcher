import type { PreparationResult } from "../shared/types";

export function PreparationFeedback({ result, onRetry, busy }: {
  result?: PreparationResult;
  onRetry(): void;
  busy: boolean;
}) {
  if (!result || result.status === "disabled") return null;
  const label = {
    ready: "Setup ready", warning: "Setup warning", blocked: "Setup blocked", deferred: "Setup pending"
  }[result.status];

  return (
    <section className={`preparation-feedback ${result.status}`} aria-label="Profile setup">
      <strong>{label}</strong>
      {result.messages.map((message, index) => (
        <div key={`${message.code}:${index}`}>
          <p>{message.message}</p>
          {message.details ? <details><summary>Details</summary><pre>{message.details}</pre></details> : null}
        </div>
      ))}
      {result.backupPath ? <details><summary>Settings backup</summary><code>{result.backupPath}</code></details> : null}
      <small>Last checked: {new Date(result.checkedAt).toLocaleString()}</small>
      {result.status !== "ready" ? <button className="secondary" disabled={busy} onClick={onRetry}>Retry setup</button> : null}
    </section>
  );
}
