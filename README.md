# Pane — Parallel Claude Code Terminal Manager

Run multiple Claude Code sessions in parallel inside a single desktop window:
a resizable grid of terminal panes, a sidebar with live status badges, and
adjustable layouts. A focused, open-source take on the BridgeSpace / cmux idea,
scoped to Claude Code.

> Built bottom-up against a stable `PtyBackend` seam so the whole UI runs in a
> browser dev harness long before Electron is wired. See the PRD for the full
> spec and milestone plan.

## Architecture

TypeScript monorepo (npm workspaces + Turborepo). The UI depends only on
`@app/core` **interfaces**; each host injects a concrete `PtyBackend` +
`Persistence`.

```
packages/
  core/          @app/core — framework-agnostic models + interfaces (zero UI deps)
  ui/            @app/ui   — React + xterm.js (TerminalPane, grid, sidebar, badges)
  app-web/       dev harness (Vite page + ws server + node-pty)
  app-electron/  Electron host (main: node-pty; renderer: @app/ui)  [M5]
```

The single seam between UI and host is `PtyBackend` (terminal I/O) and
`Persistence` (workspace state). See `packages/core/src/`.

## Requirements

- Node >= 20 (developed on Node 22)
- A C toolchain for `node-pty` (Xcode CLT on macOS, build-essential on Linux,
  VS Build Tools on Windows)
- `claude` on your `PATH` to launch real Claude Code sessions

## Build, run & verify

### 1. Install + build the packages

```bash
npm install          # installs all workspaces; builds node-pty natively
                     # (postinstall fixes the node-pty spawn-helper exec bit)
npm run build        # turbo build across all packages
npm run typecheck    # type-check everything
npm run test         # unit tests (status reducer + layout tree)
```

### 2. Run the app today — browser harness

Until the Electron host lands (M5), the app runs as a **browser dev harness**
that uses the exact same `@app/ui` + `@app/core` the desktop app will use — only
the host transport differs (websockets here, Electron IPC later).

```bash
npm run dev:web      # starts the ws/pty server AND Vite together
```

Open the printed URL (default http://localhost:5173).

**Verify (M0–M2):**
- Pick a layout — **1**, **1×2**, or **2×2** in the toolbar → that many panes appear.
- In an empty pane, set a working directory and click **Run Claude** (or
  **Shell**). The terminal becomes interactive and the `claude` TUI renders.
- Drag the dividers between panes — terminals resize and the PTY reflows.
- Each pane is an independent session; input/output never cross panes.
- The left **sidebar** lists every session with title, directory, and a live
  status badge. Click a row to focus its pane; double-click the title to rename;
  press **×** to close (kills the PTY and collapses the layout).
- Close the browser tab → all child PTYs are killed (no orphan processes).

### 3. Run the desktop app — lands in M5 (Electron)

> ⏳ Not built yet. `packages/app-electron` is a stub until milestone M5.
> Once implemented, the commands will be:

```bash
npm run dev --workspace app-electron       # hot-reload Electron window
npm run build --workspace app-electron     # build + @electron/rebuild node-pty
npm run package --workspace app-electron   # electron-builder: nsis / dmg / AppImage
```

Installers land in `packages/app-electron/release/`; auto-update via
`electron-updater`.

## Milestones

| Milestone | Epics | Outcome | Status |
|---|---|---|---|
| **M0** | 0, 1 | Browser page: one live terminal, then `claude` running in it | ✅ |
| **M1** | 2 | UI drives sessions purely through `core` + `PtyBackend` | ✅ |
| **M2** | 3, 4 | 1 / 1×2 / 2×2 layouts, resizable panes, session sidebar | ✅ |
| M3 | 5 | Status badges via Claude Code hooks → OSC | ⬜ |
| M4 | 6 | Relaunch restores layout + cwds | ⬜ |
| M5 | 7 | Installable Electron app (Win/mac/Linux) | ⬜ |

## Notes

- Uses **npm** workspaces (not pnpm).
- One dark theme only in v1.
- `@app/ui` depends only on `@app/core` interfaces — never a host package or
  `node-pty` directly. Hosts inject a `PtyBackend` + `Persistence`.
