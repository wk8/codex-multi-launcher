# Profile preparation command

An optional local command can enforce a user's own prerequisites or modify a
profile before built-in defaults and launch. The launcher has no instruction
header convention. Scripts can implement that or another local workflow using
the same versioned contract.

Add `prepareCommand` to the [profile defaults policy](profile-defaults.md):

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "scope": "all-managed-profiles",
  "mode": "enforce",
  "config": [
    { "path": ["desktop", "followUpQueueMode"], "value": "queue" }
  ],
  "prepareCommand": {
    "executable": "/absolute/path/to/node",
    "args": ["/absolute/path/to/profile-prepare.mjs"],
    "timeoutMs": 30000
  }
}
```

The [example command](../examples/profile-prepare.mjs) checks that the profile's
configuration exists. It can be adapted without changing the launcher. The
command is optional, and both settings arrays may be empty for a command-only
policy. `enabled`, `scope` and lifecycle eligibility are shared with defaults.

## Execution contract

| Option | Meaning |
| --- | --- |
| `executable` | Required program name or path. Bare names use the launcher's PATH. Relative paths containing a separator resolve against the policy directory. |
| `args` | Optional array of literal strings; defaults to `[]`. No interpolation, globbing, tilde expansion or shell parsing occurs. Use an explicit interpreter if needed. |
| `cwd` | Optional working directory; defaults to the policy's parent directory. Relative paths resolve against that directory, never the current repository. |
| `timeoutMs` | Integer from 100 through 300000; defaults to 30000. Timeout is fatal and includes command input/output processing. |

The command runs as the launcher user, inheriting the launcher's environment.
Its HOME is **not** switched to the target profile. Use the JSON paths for the
target profile. This is an explicitly configured local program with the user's
permissions, not a sandboxed plugin. No program is discovered or enabled through
project files, AGENTS.md, imported profiles, or command output. The launcher
does not execute remediation instructions returned by the program.

The current macOS host uses POSIX process groups. A Windows host integration
needs a process ownership backend (for example Job Objects) before enabling the
runner there; killing just a parent PID is insufficient. Policy validation,
the JSON protocol, planning, and feedback are independent of that host adapter.

## Input on stdin

The launcher sends exactly one UTF-8 JSON document followed by a newline and
EOF. Read the complete input before acting on profile paths. There are no
secret values or file contents in the request, and the raw registry record is
never passed through.

```json
{
  "protocolVersion": 1,
  "event": "launch",
  "invocationId": "a-unique-uuid-for-this-invocation",
  "platform": "darwin",
  "profile": {
    "id": "personal",
    "name": "Personal",
    "authMode": "chatgpt_account",
    "homeIsolated": true,
    "paths": {
      "homeDir": "/profiles/personal",
      "codexHome": "/profiles/personal/codex-home",
      "configFile": "/profiles/personal/codex-home/config.toml",
      "globalStateFile": "/profiles/personal/codex-home/.codex-global-state.json",
      "agentsFile": "/profiles/personal/codex-home/AGENTS.md",
      "userDataDir": "/launcher-data/profiles/personal/user-data",
      "launcherPath": "/launchers/personal.app",
      "desktopAppPath": "/Applications/ChatGPT.app",
      "desktopExecutablePath": "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
    },
    "appearance": { "iconBackgroundColor": "#007AFF" }
  },
  "launcher": {
    "userHomeDir": "/Users/example",
    "dataDir": "/launcher-data",
    "policyFile": "/launcher-data/profile-defaults.json"
  },
  "execution": { "cwd": "/launcher-data" }
}
```

`event` is `create`, `startup` or `launch`. **Retry setup** uses `create` for an
incomplete new profile and `startup` for an existing profile. A launch retry
still receives `launch`. Every command execution gets a fresh invocation ID.
Scripts must tolerate repeated invocations and should be idempotent.

All paths are absolute and come from resolved launcher/profile context. They
are not a promise that the corresponding file exists. `homeDir` is the actual
HOME used by the target desktop process; `codexHome` is independent of it.
Hosts that share the user's HOME must report that real path and set
`homeIsolated` to false. `userHomeDir` describes the launcher user instead.
The desktop app/executable paths use the same resolver as launch. Optional
appearance metadata contains only the documented color field.

Configuration files are in their **pre-defaults** state when the command runs.
The desired policy can be read from `launcher.policyFile`. Input fields are
versioned snapshots, not references to mutable registry objects. New optional
fields may be added within version 1; scripts should ignore fields they do not
use and reject unsupported protocol versions.

## Output on stdout

Return exactly one strict JSON object, without log lines or extra documents:

```json
{
  "protocolVersion": 1,
  "messages": [
    {
      "severity": "error",
      "code": "HEADER_MISMATCH",
      "message": "AGENTS.md has an unexpected header.",
      "details": "First difference: line 3. Correct the header and retry."
    }
  ]
}
```

`messages: []` means success. Each message needs `severity`, `code` and non-empty
`message`; `details` is optional text. Severity is `info`, `warning` or `error`.
The highest severity determines the result, with no separate `fatal` boolean.
Codes must be unique within a response, start with a letter or digit, contain
only letters/digits/underscore/dot/colon/hyphen, and be at most 128 characters.
`LAUNCHER_` is reserved for launcher feedback. Use stable codes across runs.
Responses may contain at most 100 messages; a message is limited to 8192
characters and details to 32768, within the overall stdout limit of 64 KiB.
Unknown response/message fields and duplicate JSON keys are rejected.

| Response / process result | Effect |
| --- | --- |
| Exit 0, empty or info-only messages | Continue applying defaults and launch if requested. |
| Exit 0, warning messages | Continue automatically; keep amber feedback on the profile. |
| Any error message, including exit 0 | Block defaults and launch. |
| Nonzero exit or signal, including warning-only JSON | Block defaults and launch. |
| Start failure, timeout, oversized stdout, invalid JSON/UTF-8 or protocol mismatch | Block defaults and launch with an explicit runner error. |

Stderr is diagnostic only and does not determine severity. Only its last 16 KiB
is retained, with an explicit truncation indicator. It is available in profile
details even after a successful run. Avoid putting credentials or other secret
values in diagnostic output: results are private local files, not secret stores.
Command stdout is parsed as data; feedback is rendered as plain text.

## Ordering, failures and process ownership

For each eligible stopped profile the launcher:

1. Validates the policy and reads/plans both built-in stores without changing them.
2. Starts the command, records its process-group ownership, then sends stdin.
3. Waits for the complete response and process exit, including child work.
4. If the command succeeds or warns, rechecks runtime and policy, rereads the
   profile files, and builds fresh plans so command edits are preserved.
5. Applies built-in defaults using their backup/recovery transaction, then
   launches only if requested and setup is allowed.

Pending recovery of an older built-in transaction is resolved before step 1.
A running or unknown desktop profile defers the entire operation, including
the command. Preview never executes it and labels its checks/effects as pending.
The per-profile lock spans the command, built-in writes and desktop spawn.

Commands own their own writes and rollback. The launcher does not undo a
command's changes on failure; its backups cover only subsequent built-in edits.
If a command leaves invalid TOML/JSON, the fresh plan fails before built-in
defaults are written. A command cannot change the policy and have an old plan
silently applied.

Commands must finish all child work before exiting. Do not daemonize, detach
children into other sessions/process groups, or delegate unfinished writes to
external services. Timeout/output failure terminates the process group, first
with SIGTERM and then SIGKILL, and waits for its exit. A command exiting while
background group members remain also fails and triggers cleanup. Process groups
are lifecycle control for cooperative local commands, not containment for a
program deliberately escaping them.

If cleanup cannot be confirmed, preparation, shortcut rebuilds, deletion and
launch stay blocked while the recorded group exists. Durable ownership is saved
before the profile context is sent, so a manager that restarts after an
interruption does not race a surviving command. It does not kill a stored PID
automatically on restart, since PID reuse could target a different process.
Once the old command/group has stopped, Retry performs a fresh preparation.

Creation errors leave **Setup blocked** and retain the profile for Retry/Delete.
Startup failures affect only their own profiles. Explicit Open/shortcut errors
appear immediately. The launcher never treats a cached successful result as
authorization to skip command checks on a later eligible launch.

## Warning presentation

- A warning permits defaults and launch without a confirmation dialog.
- The profile retains amber feedback and details, plus a nonblocking notice for
  a new warning in the current operation.
- Background Dock/Finder launches also request a desktop notification when
  supported. Notification failure never blocks launch; results remain stored.
- Startup uses one batch summary, rather than one notification per profile.
- Identical warnings (same code, message and details) do not repeatedly notify.
  A changed message under the same code is new feedback.
- Acknowledgment dismisses the notice, not the active warning. A later successful
  check clears warnings it no longer reports. A failed or deferred check retains
  previous warnings whose codes were not checked again.

Latest results, including event, timestamp, invocation ID, messages, bounded
stderr and process outcome, are stored under `profile-preparation` in launcher
application data. They are local only and are not sent as telemetry.

## Tests

`npm test` runs the full suite, including the command cases. Tests exercise the
protocol, input/path contract, literal argv/cwd/EOF, output limits, invalid UTF-8,
exit/signal/timeout rules, descendant cleanup, interrupted-manager ownership,
fresh planning after command edits, scopes, preview, warning acknowledgment and
deduplication, startup isolation, shortcut gating, notification fallback, and
plain-text UI rendering. Fixtures use temporary profiles and executables.
