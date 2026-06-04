import { describe, expect, it } from 'vitest';
import {
  BUNDLE_VERSION,
  buildWorkspaceBundle,
  claudeProjectSlug,
  parseBundle,
  reconcileImport,
  remapWorkspaceIds,
  resumeArgs,
  serializeBundle,
  type ChorusBundle,
} from './bundle.js';
import { buildTemplate, collectSessionIds } from './layout.js';
import type { Workspace, WorkspaceState } from './models.js';

function wsWith(name: string, ids: string[]): Workspace {
  return {
    id: `ws-${name}`,
    name,
    defaultCwd: '/home/u/proj',
    layout: buildTemplate(2, [ids[0], ids[1]]),
    sessions: [
      { sessionId: ids[0], title: 'left', cwd: '/home/u/proj' },
      { sessionId: ids[1], title: 'right', cwd: '/home/u/proj/api' },
    ],
  };
}

function stateWith(...workspaces: Workspace[]): WorkspaceState {
  return { version: 2, workspaces, activeWorkspaceId: workspaces[0].id };
}

describe('buildWorkspaceBundle + serialize/parse round-trip', () => {
  it('round-trips a Layer-1 workspace bundle unchanged', () => {
    const state = stateWith(wsWith('A', ['a1', 'a2']));
    const bundle = buildWorkspaceBundle(state);
    expect(bundle.version).toBe(BUNDLE_VERSION);
    expect(bundle.conversations).toBeUndefined();

    const parsed = parseBundle(serializeBundle(bundle));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.bundle.workspace).toEqual(state);
  });

  it('round-trips a full (Layer-2) bundle including conversations + memory', () => {
    const full: ChorusBundle = {
      version: BUNDLE_VERSION,
      exportedAt: 123,
      workspace: stateWith(wsWith('A', ['a1', 'a2'])),
      conversations: [
        {
          sessionId: 'claude-xyz',
          originalProjectPath: '/home/u/proj',
          name: 'left',
          transcript: '{"type":"message"}\n',
        },
      ],
      memoryFiles: [{ relPath: 'memory/MEMORY.md', contents: '# Memory\n' }],
    };
    const parsed = parseBundle(serializeBundle(full));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.bundle).toEqual(full);
  });
});

describe('parseBundle validation (fails safe)', () => {
  it('rejects non-JSON strings', () => {
    const r = parseBundle('not json {');
    expect(r.ok).toBe(false);
  });

  it('rejects an unsupported/old version', () => {
    const r = parseBundle({ version: 99, exportedAt: 0, workspace: {} });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('version') });
  });

  it('rejects a missing/invalid workspace state', () => {
    const r = parseBundle({ version: BUNDLE_VERSION, exportedAt: 0, workspace: { version: 1 } });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed conversations', () => {
    const state = stateWith(wsWith('A', ['a1', 'a2']));
    const r = parseBundle({
      version: BUNDLE_VERSION,
      exportedAt: 0,
      workspace: state,
      conversations: [{ sessionId: 'x' }], // missing fields
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('conversations') });
  });

  it('accepts a bundle object (already parsed, not a string)', () => {
    const bundle = buildWorkspaceBundle(stateWith(wsWith('A', ['a1', 'a2'])));
    const r = parseBundle(bundle);
    expect(r.ok).toBe(true);
  });
});

describe('reconcileImport — replace', () => {
  it('replaces the whole state with the imported workspace', () => {
    const current = stateWith(wsWith('Current', ['c1', 'c2']));
    const bundle = buildWorkspaceBundle(stateWith(wsWith('Imported', ['i1', 'i2'])));
    const { state, result } = reconcileImport(current, bundle, 'replace');
    expect(state).toEqual(bundle.workspace);
    expect(result.workspaceImported).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe('reconcileImport — merge', () => {
  it('appends imported workspaces with fresh, non-colliding ids', () => {
    const current = stateWith(wsWith('Current', ['c1', 'c2']));
    const bundle = buildWorkspaceBundle(stateWith(wsWith('Imported', ['i1', 'i2'])));
    const { state } = reconcileImport(current, bundle, 'merge');

    expect(state.workspaces).toHaveLength(2);
    const [, imported] = state.workspaces;
    expect(imported.id).not.toBe('ws-Imported'); // regenerated
    // session ids regenerated and consistent between layout + configs
    const layoutIds = collectSessionIds(imported.layout);
    const cfgIds = imported.sessions.map((s) => s.sessionId);
    expect(new Set(layoutIds)).toEqual(new Set(cfgIds));
    expect(layoutIds).not.toContain('i1');
    expect(layoutIds).not.toContain('i2');
    // active switches to the imported workspace
    expect(state.activeWorkspaceId).toBe(imported.id);
  });

  it('renames a duplicate workspace name and surfaces a warning', () => {
    const current = stateWith(wsWith('Shared', ['c1', 'c2']));
    const bundle = buildWorkspaceBundle(stateWith(wsWith('Shared', ['i1', 'i2'])));
    const { state, result } = reconcileImport(current, bundle, 'merge');
    expect(state.workspaces[1].name).toBe('Shared (imported)');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('already exists');
  });

  it('preserves session titles/cwds through the merge remap', () => {
    const current = stateWith(wsWith('Current', ['c1', 'c2']));
    const bundle = buildWorkspaceBundle(stateWith(wsWith('Imported', ['i1', 'i2'])));
    const { state } = reconcileImport(current, bundle, 'merge');
    const titles = state.workspaces[1].sessions.map((s) => s.title).sort();
    expect(titles).toEqual(['left', 'right']);
  });
});

describe('claudeProjectSlug (Layer-2 path remap)', () => {
  it('replaces every non-alphanumeric char with a dash', () => {
    expect(claudeProjectSlug('/Users/ashoknaik/claude-experiments/tui-bridgespaceclone')).toBe(
      '-Users-ashoknaik-claude-experiments-tui-bridgespaceclone',
    );
  });
  it('slugifies dots too', () => {
    expect(claudeProjectSlug('/home/u/my.proj')).toBe('-home-u-my-proj');
  });
  it('remaps to a different machine slug', () => {
    const orig = '/Users/alice/work/app';
    const local = '/home/bob/app';
    expect(claudeProjectSlug(orig)).not.toBe(claudeProjectSlug(local));
    expect(claudeProjectSlug(local)).toBe('-home-bob-app');
  });
});

describe('resumeArgs', () => {
  it('builds the --resume argv', () => {
    expect(resumeArgs('abc-123')).toEqual(['--resume', 'abc-123']);
  });
});

describe('remapWorkspaceIds', () => {
  it('keeps layout pane ids and session config ids in lockstep', () => {
    const ws = wsWith('W', ['x1', 'x2']);
    const out = remapWorkspaceIds(ws);
    expect(out.id).not.toBe(ws.id);
    const layoutIds = collectSessionIds(out.layout);
    const cfgIds = out.sessions.map((s) => s.sessionId);
    expect([...layoutIds].sort()).toEqual([...cfgIds].sort());
  });
});
