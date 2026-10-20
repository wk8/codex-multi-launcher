import type { PreparationResult } from "../shared/types";
import { warningsAcknowledged } from "../shared/preparation-feedback";

export function PreparationFeedback({ result, onRetry, onAcknowledge, busy }: {
  result?: PreparationResult;
  onRetry(): void;
  onAcknowledge(): void;
  busy: boolean;
}) {
  if (!result || result.status === "disabled") return null;
  const label = {
    ready: "Setup ready", warning: "Setup warning", blocked: "Setup blocked", deferred: "Setup pending"
  }[result.status];
  const acknowledged = warningsAcknowledged(result);
  const hasWarnings = result.messages.some((message) => message.severity === "warning");

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
      {result.command?.stderr ? <details><summary>Command diagnostics{result.command.stderrTruncated ? " (last 16 KiB)" : ""}</summary><pre>{result.command.stderr}</pre></details> : null}
      <small>Last checked: {new Date(result.checkedAt).toLocaleString()}</small>
      {hasWarnings ? acknowledged ? <small>Warnings acknowledged; they remain active until a successful check clears them.</small>
        : <button className="secondary" disabled={busy} onClick={onAcknowledge}>Acknowledge warnings</button> : null}
      {result.status !== "ready" ? <button className="secondary" disabled={busy} onClick={onRetry}>Retry setup</button> : null}
    </section>
  );
}
