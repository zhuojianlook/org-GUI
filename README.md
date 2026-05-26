# org-GUI

A desktop GUI wrapper around **Emacs org-mode** that visualizes an `.org` file
as a **timeline node graph** — headings become nodes placed along a time axis
(by their `SCHEDULED` / `DEADLINE` / timestamps), with parent→child edges, so
comparable tiers (siblings) can be seen and compared at a glance instead of
scrolling one long outline.

Editing is **round-trip**: changes are applied by your *actual running Emacs*
via `emacsclient`, so the file stays 100% org-faithful and Doom Emacs keeps
working on the same file.

Built with Tauri 2 (Rust + React) — same auto-updating desktop pattern as
multipanelfigure.

## How it works

```
React (xyflow timeline) ──invoke──▶ Rust (Tauri)
                                       │  emacsclient --eval
                                       ▼
                            Your running Emacs server
                                       │  org-gui-bridge.el
                                       ▼
                                  org-mode engine  ◀─▶  your .org file
```

- The frontend never parses org itself. It calls bridge functions
  (`org-gui-parse`, `org-gui-set-todo`, `org-gui-set-scheduled`, …) defined in
  [`org-gui-bridge.el`](TauriApp/src-tauri/resources/org-gui-bridge.el).
- The bridge writes its JSON result to a temp file (sidestepping emacsclient's
  string escaping); Rust reads and returns it.
- Every mutation edits the live buffer, **saves**, and returns the freshly
  re-parsed document, so the UI is always in sync with disk.

## Requirements

- **Emacs with a running server.** The app talks to it via `emacsclient`.
  Doom Emacs starts a server by default; otherwise add `(server-start)` to your
  config or run `M-x server-start`. Verify with:
  ```bash
  emacsclient --eval "(+ 1 1)"   # should print 2
  ```
- If `emacsclient` isn't on the GUI app's PATH, set `ORG_GUI_EMACSCLIENT` to its
  absolute path (common Homebrew/macOS locations are probed automatically).

## Development

```bash
cd TauriApp
nvm use            # Node 22 (see .nvmrc)
npm install
npx tauri dev
```

`tauri dev` runs Vite (`npm run dev`) automatically. Open the bundled
`TauriApp/samples/demo.org` to see the timeline view.

## Build

```bash
cd TauriApp
npx tauri build    # installers land in src-tauri/target/release/bundle/
```

## Releases & auto-update

Tagging triggers [`.github/workflows/release.yml`](.github/workflows/release.yml),
which builds macOS (Apple Silicon) + Windows, signs the updater artifacts, pushes
a manifest to the `updater` branch, and creates a GitHub Release.

```bash
git tag v0.1.1   && git push origin v0.1.1     # stable channel
git tag exp-0.1.1 && git push origin exp-0.1.1  # experimental channel
```

The in-app updater reads
`https://raw.githubusercontent.com/zhuojianlook/org-GUI/updater/latest.json`.

### Required GitHub secrets

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.org-gui/orggui_updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the key password (empty if generated with `--password ""`) |

The matching **public** key is committed in `tauri.conf.json` (`plugins.updater.pubkey`).
Keep the private key safe — losing it breaks updates for installed clients.

## Status

Implemented: open a single `.org` file, timeline node-graph view (time x-axis,
hierarchy edges, month + today gridlines, minimap, pan/zoom), detail panel,
round-trip editing of title / TODO state / priority / scheduled / deadline /
tags, and drag-a-node-to-reschedule.

Planned: add/delete/move headings, body editing, multi-file (directory) mode,
alternate layouts (tier swimlanes), agenda/clock integration.

## License

MIT — created by Zhuojian Look.
