# Codex Personal Launcher

This branch is a local-only, macOS-only derivative of the upstream `v0.1.9`
tag. It exists for one purpose: launch the official ChatGPT/Codex desktop
binary with an isolated personal account profile beside the normal work
profile.

## Enforced boundaries

- Profiles always use ChatGPT account login.
- Each profile receives a synthetic `HOME` containing only personal user
  configuration.
- Each profile receives a new, empty `CODEX_HOME`.
- User skills and personal plugins resolve inside that synthetic home instead
  of the macOS account's shared `~/.agents` directory.
- Each profile receives a separate Chromium/Electron `--user-data-dir`.
- Default Codex configuration, history, instructions, plugins, skills, MCP
  configuration, and credentials cannot be imported.
- Inherited `OPENAI_*`, `CODEX_*`, `CHATGPT_*`, and `ELECTRON_*` environment
  variables are removed before launch.
- The manager contains no subscription integration, announcements,
  promotional telemetry, update checks, or self-updater.
- Packaged builds contain only modules reachable from the hardened entry
  points.

The official ChatGPT/Codex application still connects to OpenAI after it is
launched. This document describes the local launcher, not the network behavior
of the official application.

For a profile whose id is `personal`, the important paths are:

```text
~/.codex-personal-profiles/personal/codex-home/config.toml
~/.codex-personal-profiles/personal/.agents/skills
~/.codex-personal-profiles/personal/codex-home/skills
```

Codex also loads repository-scoped skills from `.agents/skills` inside the
repository being used. Those intentionally follow the repository: do not open
a work repository in the personal instance if its checked-in skills or
instructions should not be sent to the personal account.

Because `HOME` is isolated, tools launched inside the personal instance also
use the personal profile as `~`. Refer to macOS files by absolute path when
needed, and create separate personal shell, Git, or SSH configuration there
instead of linking work configuration into it.

## Verify

```bash
npm ci
npm test
```

The isolation verification creates fake work history, configuration, plugins,
skills, and credentials; creates two personal profiles; launches a fake desktop
executable; and verifies that work data, skill roots, and environment
credentials do not cross the boundary.

## Build for Apple silicon

```bash
npm run package:mac
```

The application is written to:

```text
dist-app/mac-arm64/Codex Personal Launcher.app
```

It is intentionally not connected to the upstream release/update channel. The
build command applies a local ad-hoc signature for Apple silicon; it is not
Developer ID signed or notarized.

After packaging, run `npm run verify:packaged-profile`. This creates two
profiles in a temporary home using the packaged code after clearing Electron's
temporary icon extraction, checking that profile creation survives temp cleanup.

## First-run acceptance check

1. Leave the normal desktop app signed into the work account.
2. Create and open a personal profile.
3. Sign into a distinct personal account using a non-work email address.
4. Quit and reopen both applications.
5. Confirm the account email and active workspace in each window before
   entering private or work content.

The upstream repository does not include a license. Keep this derivative local
unless the copyright holder grants redistribution rights.

## Browser return links

The packaged launcher handles `codex://` links and asks which running window
started the browser flow. Choose `Personal: perso` for a connection started in
that profile, or `Main app` for the normal account. Keep the originating window
open until the browser flow finishes.

Callbacks do not identify the isolated profile. The launcher never chooses an
account automatically. It rechecks the selected process and sends the original
URL directly to that PID as a macOS Get URL event. Callback contents are held in
memory and sent over stdin, not logged, stored, or passed as process arguments.
The official app remains responsible for validating the OAuth callback.

Opening the packaged launcher registers it for `codex://` links. The official
app can reclaim that handler when it starts; use **Use launcher for browser
links** before connecting if the launcher reports that it is no longer active.
Ordinary HTTP and HTTPS links keep their existing browser handler.

Run `npm run verify:browser-links` for routing checks and
`npm run verify:browser-links:mac` for delivery to two temporary Electron
receivers. These checks use synthetic links and no real credentials.
