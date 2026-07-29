---
description: Build the macOS DMG (packages/app-electron/release/Chorus-0.1.0-arm64.dmg)
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

Build the Chorus macOS installer so the user can test the current working-tree
changes in the real desktop app.

Steps:

1. Typecheck first — a broken build wastes several minutes:
   `npm run typecheck`
   If it fails, report the errors and stop. Do not package a broken tree.

2. Package (from the repo root, ~2-4 min; give it a generous timeout):
   `npm run dist --workspace app-electron`
   This runs `electron-vite build && electron-builder`, which rebuilds the
   renderer bundle from `packages/ui` and emits into `packages/app-electron/release/`.

3. Verify the artifact actually rebuilt — check that its mtime is from this run,
   not a stale copy:
   `ls -lh packages/app-electron/release/*.dmg`

4. Report the DMG path and its timestamp/size. Mention that the app must be
   fully quit and relaunched from the new DMG (an already-running Chorus keeps
   the old bundle).

Notes:
- node-pty is a native module. If the build fails on it, run
  `npm run rebuild --workspace app-electron` and retry step 2.
- `$ARGUMENTS`, if given, names what changed in this build — echo it back in the
  summary so the user knows which changes the DMG contains.
