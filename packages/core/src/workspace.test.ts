import { describe, expect, it } from 'vitest';
import {
  addWorkspace,
  createWorkspace,
  defaultWorkspaceState,
  getActiveWorkspace,
  removeSessionConfig,
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
