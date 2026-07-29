import { describe, expect, it } from 'vitest';
import {
  addWorkspace,
  createWorkspace,
  defaultWorkspaceState,
  findWorkspaceForClaudeSession,
  getActiveWorkspace,
  orderWorkspaces,
  parseAppSettings,
  removeSessionConfig,
  parseWorkspaceState,
  removeWorkspace,
  setActiveWorkspace,
  setWorkspaceLayout,
  updateWorkspace,
  upsertSession,
} from './workspace';
import { buildTemplate } from './layout';

describe('workspace model', () => {
  it('default state has one active workspace', () => {
    const s = defaultWorkspaceState('~/code');
    expect(s.version).toBe(2);
    expect(s.workspaces).toHaveLength(1);
    expect(getActiveWorkspace(s)?.id).toBe(s.activeWorkspaceId);
    expect(getActiveWorkspace(s)?.defaultCwd).toBe('~/code');
  });

  it('creates workspaces with unique ids and a layout', () => {
    const a = createWorkspace({ template: 4 });
    const b = createWorkspace();
    expect(a.id).not.toBe(b.id);
    expect(a.layout.type).toBe('split');
    expect(b.layout).toEqual(buildTemplate(1, [(b.layout as { sessionId: string }).sessionId]));
  });

  it('adds and activates a workspace', () => {
    let s = defaultWorkspaceState();
    const ws = createWorkspace({ name: 'Second' });
    s = addWorkspace(s, ws);
    expect(s.workspaces).toHaveLength(2);
    expect(s.activeWorkspaceId).toBe(ws.id);
  });

  it('removing the active workspace re-points active', () => {
    let s = defaultWorkspaceState();
    const first = s.activeWorkspaceId;
    s = addWorkspace(s, createWorkspace({ name: 'Second' }));
    s = removeWorkspace(s, s.activeWorkspaceId);
    expect(s.activeWorkspaceId).toBe(first);
    expect(s.workspaces).toHaveLength(1);
  });

  it('removing the last workspace falls back to a default', () => {
    let s = defaultWorkspaceState();
    s = removeWorkspace(s, s.activeWorkspaceId);
    expect(s.workspaces).toHaveLength(1);
  });

  it('setActiveWorkspace ignores unknown ids', () => {
    const s = defaultWorkspaceState();
    expect(setActiveWorkspace(s, 'nope')).toBe(s);
  });

  it('updateWorkspace patches immutably', () => {
    const s = defaultWorkspaceState();
    const id = s.activeWorkspaceId;
    const next = updateWorkspace(s, id, { name: 'Renamed' });
    expect(getActiveWorkspace(next)?.name).toBe('Renamed');
    expect(getActiveWorkspace(s)?.name).not.toBe('Renamed');
  });

  it('upsert/remove session config within a workspace', () => {
    let s = defaultWorkspaceState();
    const id = s.activeWorkspaceId;
    s = upsertSession(s, id, { sessionId: 's1', title: 't', cwd: '/tmp' });
    expect(getActiveWorkspace(s)?.sessions).toHaveLength(1);
    // upsert replaces, not duplicates
    s = upsertSession(s, id, { sessionId: 's1', title: 't2', cwd: '/tmp' });
    expect(getActiveWorkspace(s)?.sessions).toHaveLength(1);
    expect(getActiveWorkspace(s)?.sessions[0].title).toBe('t2');
    s = removeSessionConfig(s, 's1');
    expect(getActiveWorkspace(s)?.sessions).toHaveLength(0);
  });

  it('setWorkspaceLayout updates the layout', () => {
    const s = defaultWorkspaceState();
    const id = s.activeWorkspaceId;
    const layout = buildTemplate(2, ['x', 'y']);
    const next = setWorkspaceLayout(s, id, layout);
    expect(getActiveWorkspace(next)?.layout).toEqual(layout);
  });
});

describe('findWorkspaceForClaudeSession', () => {
  it('finds the workspace a session was opened from', () => {
    let s = defaultWorkspaceState();
    const ws = { ...createWorkspace({ name: 'Resumed' }), sourceSessionId: 'conv-1' };
    s = addWorkspace(s, ws);
    expect(findWorkspaceForClaudeSession(s, 'conv-1')?.id).toBe(ws.id);
  });

  it('finds a workspace whose pane runs the conversation', () => {
    let s = defaultWorkspaceState();
    const id = s.activeWorkspaceId;
    s = upsertSession(s, id, {
      sessionId: 's1',
      title: 't',
      cwd: '/tmp',
      claudeSessionId: 'conv-2',
    });
    expect(findWorkspaceForClaudeSession(s, 'conv-2')?.id).toBe(id);
  });

  it('returns undefined for a conversation nothing has open', () => {
    const s = defaultWorkspaceState();
    expect(findWorkspaceForClaudeSession(s, 'conv-3')).toBeUndefined();
  });
});

describe('orderWorkspaces', () => {
  it('lifts pinned workspaces above the rest, each group keeping its order', () => {
    const a = createWorkspace({ name: 'a' });
    const b = { ...createWorkspace({ name: 'b' }), pinned: true };
    const c = createWorkspace({ name: 'c' });
    const d = { ...createWorkspace({ name: 'd' }), pinned: true };
    expect(orderWorkspaces([a, b, c, d]).map((w) => w.name)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });

  it('leaves an all-unpinned list untouched', () => {
    const list = [createWorkspace({ name: 'a' }), createWorkspace({ name: 'b' })];
    expect(orderWorkspaces(list)).toEqual(list);
  });
});

describe('parseWorkspaceState', () => {
  it('round-trips valid state', () => {
    const s = defaultWorkspaceState('~/x');
    expect(parseWorkspaceState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('rejects null / non-objects / wrong version', () => {
    expect(parseWorkspaceState(null)).toBeNull();
    expect(parseWorkspaceState('nope')).toBeNull();
    expect(parseWorkspaceState({ version: 1, layout: {}, sessions: [] })).toBeNull();
  });

  it('rejects empty or malformed workspaces', () => {
    expect(parseWorkspaceState({ version: 2, workspaces: [], activeWorkspaceId: 'x' })).toBeNull();
    expect(
      parseWorkspaceState({
        version: 2,
        workspaces: [{ id: 'a', name: 'n' /* missing layout */ }],
        activeWorkspaceId: 'a',
      }),
    ).toBeNull();
  });

  it("keeps a pane's kind and rejects an unknown one", () => {
    const base = defaultWorkspaceState();
    const withKind = (kind: unknown) => {
      const s = JSON.parse(JSON.stringify(base));
      s.workspaces[0].sessions = [
        { sessionId: 'p1', title: 'shell · x', cwd: '/x', kind },
      ];
      return parseWorkspaceState(s);
    };
    expect(withKind('shell')?.workspaces[0].sessions[0].kind).toBe('shell');
    expect(withKind('claude')?.workspaces[0].sessions[0].kind).toBe('claude');
    expect(withKind(undefined)?.workspaces[0].sessions[0].kind).toBeUndefined();
    expect(withKind('agent')).toBeNull();
  });

  it('keeps the SESSIONS panel state and drops a malformed one', () => {
    const base = defaultWorkspaceState();
    const withPanel = parseAppSettings({
      sessionsPanel: { open: true, expanded: ['/a', 7, '/b'] },
    });
    expect(withPanel?.sessionsPanel).toEqual({ open: true, expanded: ['/a', '/b'] });

    // `open` is what the panel is; without it there is nothing to restore.
    expect(parseAppSettings({ sessionsPanel: { expanded: ['/a'] } })).toBeUndefined();

    const parsed = parseWorkspaceState({
      ...JSON.parse(JSON.stringify(base)),
      settings: { sessionsPanel: { open: false } },
    });
    expect(parsed?.settings).toEqual({ sessionsPanel: { open: false } });
  });

  it('repairs a dangling activeWorkspaceId to the first workspace', () => {
    const s = defaultWorkspaceState();
    const broken = { ...s, activeWorkspaceId: 'gone' };
    const parsed = parseWorkspaceState(JSON.parse(JSON.stringify(broken)));
    expect(parsed?.activeWorkspaceId).toBe(s.workspaces[0].id);
  });
});
