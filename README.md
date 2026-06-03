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

## Getting started

```bash
npm install          # installs all workspaces, builds node-pty natively
npm run build        # turbo run build across packages
npm run typecheck    # type-check everything
```

### Dev harness (M0 — browser)

```bash
npm run dev:web      # starts the ws/pty server + Vite, then open the printed URL
```

In the page: set a working directory, then **Open shell** (platform default
shell) or **Run claude** (launches Claude Code inside the shell). Typing,
streaming output, and window-resize → PTY resize all work; closing the tab
kills the PTY.

## Milestones

| Milestone | Epics | Outcome |
|---|---|---|
| **M0** | 0, 1 | Browser page: one live terminal, then `claude` running in it ✅ |
| M1 | 2 | UI drives sessions purely through `core` + `PtyBackend` |
| M2 | 3, 4 | 4-pane layout, resizable panes, session sidebar |
| M3 | 5 | Status badges via Claude Code hooks → OSC |
| M4 | 6 | Relaunch restores layout + cwds |
| M5 | 7 | Installable Electron app (Win/mac/Linux) |

## Notes

- Uses **npm** workspaces (not pnpm).
- One dark theme only in v1.
