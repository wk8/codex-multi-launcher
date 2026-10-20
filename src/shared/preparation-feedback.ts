import type { PreparationMessage, PreparationResult } from "./types.js";

export function warningIdentity(message: PreparationMessage): string {
  return JSON.stringify([message.code, message.message, message.details ?? ""]);
}

export function warningsAcknowledged(result: PreparationResult): boolean {
  const warnings = result.messages.filter((message) => message.severity === "warning");
  return warnings.length > 0 && warnings.every((message) => result.acknowledgedWarnings?.includes(message.code));
}

export function newWarnings(result: PreparationResult): PreparationMessage[] {
  return result.messages.filter((message) => message.severity === "warning" && result.newWarningCodes?.includes(message.code));
}

export function reconcileWarnings(result: PreparationResult, previous: PreparationResult | null): PreparationResult {
  const messages = [...result.messages];
  if (result.status === "blocked" || result.status === "deferred") {
    for (const message of previous?.messages ?? []) {
      if (message.severity === "warning" && !messages.some((current) => current.code === message.code)) messages.push(message);
    }
  }
  const previousWarnings = new Set(previous?.messages.filter((message) => message.severity === "warning").map(warningIdentity));
  const warnings = messages.filter((message) => message.severity === "warning");
  return {
    ...result,
    messages,
    newWarningCodes: warnings.filter((message) => !previousWarnings.has(warningIdentity(message))).map((message) => message.code),
    acknowledgedWarnings: warnings.filter((message) => previous?.acknowledgedWarnings?.includes(message.code)
      && previousWarnings.has(warningIdentity(message))).map((message) => message.code)
  };
}
