# Profile defaults

The launcher can apply an explicit local policy to the profiles it manages.
Nothing is inherited from the main app or another profile. The feature is off
when the policy file is absent or `enabled` is false.

An optional [preparation command](preparation-command.md) can run user-defined
checks or changes before these defaults. It receives profile/path context on
stdin and reports warnings or blocking errors through a versioned JSON response.

Create `profile-defaults.json` in the launcher's application-data directory. In
this macOS build that is `~/Library/Application Support/Codex Personal Launcher`.
The **Preview defaults** action shows the resolved policy path. Policies are
never discovered in a repository, profile, or instruction file.

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "scope": "all-managed-profiles",
  "mode": "enforce",
  "config": [
    { "path": ["desktop", "followUpQueueMode"], "value": "queue" },
    { "path": ["desktop", "notifications-turn-mode"], "value": "always" }
  ],
  "desktopState": [
    { "path": ["electron-initial-follow-up-queue-mode"], "value": "queue" }
  ]
}
```

## Policy contract

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Must be `1`. Unknown fields, versions and malformed policies block preparation with feedback. |
| `enabled` | Explicit boolean. Disabling or removing the policy stops enforcement and leaves the last saved settings in place. |
| `scope` | `new-profiles` applies during creation; `all-managed-profiles` also applies to existing managed profiles at launcher startup and immediately before Open. |
| `mode` | `fill-missing` preserves existing preferences, including false, zero and null; `enforce` restores the specified values on every applicable preparation. |
| `config` | Optional array of edits to `CODEX_HOME/config.toml`. |
| `desktopState` | Optional array of edits to `CODEX_HOME/.codex-global-state.json`. |
| `prepareCommand` | Optional local command, with the same scope and lifecycle. See its [contract](preparation-command.md). |
| edit `path` | Array of literal object keys, not dotted notation. For example, `["desktop", "a.b"]` refers to a single key containing a dot. Numeric array indices are unsupported. |
| edit `value` | String, boolean, finite number, or array. JSON state also permits null. Arrays are replaced as a whole and may contain objects; object members otherwise need their own leaf paths. |

Defaults cannot replace whole tables/objects, traverse scalar/array parents, or
use overlapping/duplicate paths. Prototype-related keys are rejected. Integer
values must be exactly representable as JavaScript numbers. TOML nulls and dates
are not part of this JSON policy contract. The policy is limited to 1 MiB, each
store to 16 MiB, and each list to 512 paths of at most 32 keys.

The host reserves provider, model-selection and authentication configuration
paths. This includes `model`, `model_provider`, `model_reasoning_effort`,
`model_providers`, forced login/workspace settings and credential-store settings.
Integrations can extend the ownership list in `parseDefaultsPolicy`. Desktop
reasoning-choice visibility preferences remain ordinary leaf settings.

The TOML adapter uses parsed source ranges and validates the resulting TOML 1.0
document. It preserves unrelated values, comments, quoted/dotted keys, tables
and multiline values. Replaced arrays retain internal comments; an array with
comments cannot be replaced by a scalar. Arrays of tables cannot be replaced by
leaf defaults. The JSON adapter edits source ranges too, retaining unrelated
content and numeric precision. It requires strict JSON with unique object keys.
The adapters do not guess the meaning of unknown Codex setting names.

Desktop state is an optional, version-sensitive adapter. Its internal keys may
change with Codex releases, and a running app may overwrite externally edited
preferences. Test your chosen keys with your installed app version.

## Lifecycle and feedback

Creation initializes ordinary isolated profile storage first, then prepares it.
A preparation failure retains the profile as **Setup blocked**, with **Retry
setup** and **Delete** available. Incomplete creation under `new-profiles` remains
eligible for retries, including after a launcher restart. After a successful
creation, that scope no longer enforces defaults on later launches.

Startup prepares each existing profile independently. An invalid profile does
not prevent the other profiles being prepared. Open, including Dock/Finder
shortcuts and second-instance requests, waits for startup and then performs a
fresh check. A saved successful result never bypasses this check. Concurrent
opens of the same profile coalesce; a per-profile lock covers preparation through
spawn. Registry updates are serialized and atomically saved.

A running profile, or an unknown runtime, gets **Setup pending**. The launcher
does not stop it or write its settings. Close it and choose **Retry setup**, or
open it after closing. Runtime is checked again immediately before writes.
Rebuilding/deleting a running or unknown profile is also blocked. The main app
is outside the registry and is unaffected.

**Preview defaults** reads and validates the policy and both plans without
writing settings, backups or result records. It lists changed paths and their
current/default values. The manager displays a startup summary and persistent
per-profile results with details and retry controls. The latest result is stored
under `profile-preparation` in application data; it includes event, timestamp,
messages, changed file paths and the backup location, not a copy of setting
values. Feedback is local and has no telemetry.

## File safety and recovery

Both files are validated before any defaults are written. Existing permissions
are preserved; new files use mode 0600. Profile storage and settings files must
not redirect through symbolic links. Missing state can be created, but invalid
state is never treated as empty. A policy applying to only one store does not
read or modify the other store.

Each changed file has a private backup under `profile-defaults-backups` in
application data. Replacement uses a flushed temporary file and atomic rename.
The whole pair is not an OS-level atomic transaction: a journal records the
originals before either replacement. An ordinary write failure restores the
originals; an interrupted process leaves a journal recovered before the next
preparation. Recovery defers while the profile is running or unknown and blocks
if a file or backup has been edited externally. The error reports the backup
directory for manual inspection; it does not overwrite the external edit.
Backups are retained until the user removes them. Do not remove pending journals
until the associated recovery has been resolved.

Fingerprints are checked before writing to detect concurrent changes. These
checks and the manager's lock cannot exclude an unrelated external writer in the
instant between a check and rename; close the profile and avoid editing settings
while preparing it. Recovery covers process interruption, not a guarantee of
cross-file atomicity during a hardware/storage failure. No-op preparation creates
no backups and leaves profile files byte-for-byte unchanged.

## Verification

`npm test` runs the existing isolation and browser-link checks plus the defaults
suite. `npm run verify:defaults` runs the focused suite. All profile and executable
fixtures live in temporary homes; no real profile or desktop app is launched.
The integration tests need permission to read the macOS process list. Tests cover
policy validation/ownership, both modes/scopes, syntax-preserving edits, preview,
no-ops, runtime transitions, stale plans, write faults, rollback and journal
recovery, retained setup failures, concurrent create/open, startup isolation,
shortcut gating, IPC exposure and safe feedback rendering.
