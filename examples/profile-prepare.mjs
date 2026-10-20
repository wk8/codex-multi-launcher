import fs from "node:fs/promises";

// Read the complete request, including EOF, before acting on any profile path.
let inputText = "";
for await (const chunk of process.stdin) inputText += chunk;

let messages;
try {
  const input = JSON.parse(inputText);
  if (input.protocolVersion !== 1) throw new Error("Unsupported input protocol.");
  await fs.access(input.profile.paths.configFile);
  messages = [{ severity: "info", code: "CONFIG_ACCESSIBLE", message: `Configuration is accessible for ${input.profile.name}.` }];
} catch (error) {
  messages = [{ severity: "error", code: "CONFIG_CHECK_FAILED", message: error instanceof Error ? error.message : String(error) }];
  process.exitCode = 1;
}

// Stdout is reserved for exactly one response. Send any diagnostic logs to stderr.
process.stdout.write(JSON.stringify({ protocolVersion: 1, messages }) + "\n");
