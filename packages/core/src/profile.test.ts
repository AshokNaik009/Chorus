import { describe, expect, it } from 'vitest';
import {
  assembleProfile,
  diffProfileFiles,
  isSafeEntityId,
  planProfileFiles,
  STORE_VERSION,
} from './profile';
import type {
  ProfileFiles,
  SessionConfig,
  SwarmDef,
  Workspace,
  WorkspaceState,
} from './index';

function session(id: string, title = id): SessionConfig {
  return { sessionId: id, title, cwd: '~' };
}

function swarm(id: string, workspaceId: string): SwarmDef {
  return {
    swarmId: id,
    workspaceId,
    name: `swarm ${id}`,
    members: [{ sessionId: 's-m1', role: 'backend' }],
  };
}

function workspace(id: string, sessions: SessionConfig[]): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    defaultCwd: '~/code',
    layout:
      sessions.length > 0
        ? { type: 'pane', sessionId: sessions[0].sessionId }
        : { type: 'pane', sessionId: 's-empty' },
    sessions,
  };
}

/** Two workspaces: ws-b (sessions, swarm, every optional field) before ws-a. */
function sampleState(): WorkspaceState {
  const b: Workspace = {
    ...workspace('ws-b', [session('s-b1'), session('s-b2')]),
    mode: 'swarm',
    view: 'tabs',
    pinned: true,
    sourceSessionId: 'conv-b',
    swarms: [swarm('swarm-1', 'ws-b')],
  };
  const a = workspace('ws-a', [session('s-a1')]);
  return {
    version: 2,
    workspaces: [b, a],
    activeWorkspaceId: 'ws-a',
    settings: {
      voice: { engineId: 'whisper-wasm', mode: 'insert', hotkey: 'X' },
    },
  };
}

describe('planProfileFiles', () => {
  it('emits exactly the expected paths', () => {
    const files = planProfileFiles(sampleState());
    expect(Object.keys(files).sort()).toEqual([
      'settings.json',
      'state.json',
      'workspaces/ws-a/sessions/s-a1.json',
      'workspaces/ws-a/workspace.json',
      'workspaces/ws-b/sessions/s-b1.json',
      'workspaces/ws-b/sessions/s-b2.json',
      'workspaces/ws-b/swarms/swarm-1.json',
      'workspaces/ws-b/workspace.json',
    ]);
    const meta = JSON.parse(files['state.json']);
    expect(meta).toEqual({
      storeVersion: STORE_VERSION,
      activeWorkspaceId: 'ws-a',
      workspaceOrder: ['ws-b', 'ws-a'],
    });
  });

  it('is deterministic: identical states -> byte-identical bodies', () => {
    expect(planProfileFiles(sampleState())).toEqual(
      planProfileFiles(sampleState()),
    );
  });

  it('omits settings.json when there are no settings', () => {
    const state = { ...sampleState(), settings: undefined };
    delete state.settings;
    expect('settings.json' in planProfileFiles(state)).toBe(false);
  });

  it('skips entities with path-unsafe ids', () => {
    const state = sampleState();
    state.workspaces[1].sessions.push(session('../evil'));
    const files = planProfileFiles(state);
    expect(Object.keys(files).some((p) => p.includes('evil'))).toBe(false);
    const meta = JSON.parse(files['workspaces/ws-a/workspace.json']);
    expect(meta.sessionOrder).toEqual(['s-a1']);
  });
});

describe('plan -> assemble round-trip', () => {
  it('preserves workspaces, order, active id, settings, and optional fields', () => {
    const state = sampleState();
    const { state: back, incompatible } = assembleProfile(
      planProfileFiles(state),
    );
    expect(incompatible).toBe(false);
    expect(back).toEqual(state);
  });

  it('round-trips a workspace with an empty swarms array (vs. absent)', () => {
    const withEmpty: WorkspaceState = {
      version: 2,
      workspaces: [{ ...workspace('ws-a', [session('s-a1')]), swarms: [] }],
      activeWorkspaceId: 'ws-a',
    };
    const back = assembleProfile(planProfileFiles(withEmpty)).state;
    expect(back?.workspaces[0].swarms).toEqual([]);

    const withAbsent: WorkspaceState = {
      version: 2,
      workspaces: [workspace('ws-a', [session('s-a1')])],
      activeWorkspaceId: 'ws-a',
    };
    const back2 = assembleProfile(planProfileFiles(withAbsent)).state;
    expect(back2?.workspaces[0].swarms).toBeUndefined();
  });
});

describe('diffProfileFiles', () => {
  it('identical states -> empty diff', () => {
    const files = planProfileFiles(sampleState());
    const d = diffProfileFiles(files, planProfileFiles(sampleState()));
    expect(d.writes).toEqual({});
    expect(d.deletes).toEqual([]);
  });

  it('one session title change -> exactly one write, no deletes', () => {
    const prev = planProfileFiles(sampleState());
    const next = sampleState();
    next.workspaces[0].sessions[1] = session('s-b2', 'renamed');
    const d = diffProfileFiles(prev, planProfileFiles(next));
    expect(Object.keys(d.writes)).toEqual([
      'workspaces/ws-b/sessions/s-b2.json',
    ]);
    expect(d.deletes).toEqual([]);
  });

  it('removing a workspace deletes all of its files', () => {
    const prev = planProfileFiles(sampleState());
    const next = sampleState();
    next.workspaces = next.workspaces.filter((w) => w.id !== 'ws-b');
    const d = diffProfileFiles(prev, planProfileFiles(next));
    expect(d.deletes.sort()).toEqual([
      'workspaces/ws-b/sessions/s-b1.json',
      'workspaces/ws-b/sessions/s-b2.json',
      'workspaces/ws-b/swarms/swarm-1.json',
      'workspaces/ws-b/workspace.json',
    ]);
    // state.json changes (order + active), nothing else rewritten
    expect(Object.keys(d.writes)).toEqual(['state.json']);
  });

  it('null prev writes everything and deletes nothing', () => {
    const files = planProfileFiles(sampleState());
    const d = diffProfileFiles(null, files);
    expect(d.writes).toEqual(files);
    expect(d.deletes).toEqual([]);
  });
});

describe('assembleProfile tolerance', () => {
  it('empty tree -> null state, compatible', () => {
    expect(assembleProfile({})).toEqual({ state: null, incompatible: false });
  });

  it('unknown storeVersion -> incompatible, null state', () => {
    const files = planProfileFiles(sampleState());
    files['state.json'] = JSON.stringify({
      storeVersion: STORE_VERSION + 1,
      activeWorkspaceId: 'ws-a',
      workspaceOrder: [],
    });
    expect(assembleProfile(files)).toEqual({
      state: null,
      incompatible: true,
    });
  });

  it('a corrupt session file is skipped; siblings survive', () => {
    const files = planProfileFiles(sampleState());
    files['workspaces/ws-b/sessions/s-b1.json'] = 'garbage{';
    const state = assembleProfile(files).state;
    const b = state?.workspaces.find((w) => w.id === 'ws-b');
    expect(b?.sessions.map((s) => s.sessionId)).toEqual(['s-b2']);
    expect(state?.workspaces).toHaveLength(2);
  });

  it('a session file whose body id mismatches its filename is skipped', () => {
    const files = planProfileFiles(sampleState());
    files['workspaces/ws-b/sessions/s-b1.json'] = JSON.stringify(
      session('s-other'),
    );
    const b = assembleProfile(files).state?.workspaces.find(
      (w) => w.id === 'ws-b',
    );
    expect(b?.sessions.map((s) => s.sessionId)).toEqual(['s-b2']);
  });

  it('a corrupt workspace.json skips only that workspace', () => {
    const files = planProfileFiles(sampleState());
    files['workspaces/ws-b/workspace.json'] = '{"nope": true}';
    const state = assembleProfile(files).state;
    expect(state?.workspaces.map((w) => w.id)).toEqual(['ws-a']);
    expect(state?.activeWorkspaceId).toBe('ws-a');
  });

  it('missing state.json still loads: sorted order, first active', () => {
    const files = planProfileFiles(sampleState());
    delete files['state.json'];
    const state = assembleProfile(files).state;
    expect(state?.workspaces.map((w) => w.id)).toEqual(['ws-a', 'ws-b']);
    expect(state?.activeWorkspaceId).toBe('ws-a');
  });

  it('an active id pointing at a missing workspace falls back to first', () => {
    const files = planProfileFiles(sampleState());
    files['state.json'] = JSON.stringify({
      storeVersion: STORE_VERSION,
      activeWorkspaceId: 'ws-gone',
      workspaceOrder: ['ws-b', 'ws-a'],
    });
    expect(assembleProfile(files).state?.activeWorkspaceId).toBe('ws-b');
  });

  it('a straggler session file not in sessionOrder is appended', () => {
    const files = planProfileFiles(sampleState());
    files['workspaces/ws-a/sessions/s-extra.json'] = JSON.stringify(
      session('s-extra'),
    );
    const a = assembleProfile(files).state?.workspaces.find(
      (w) => w.id === 'ws-a',
    );
    expect(a?.sessions.map((s) => s.sessionId)).toEqual(['s-a1', 's-extra']);
  });

  it('a corrupt settings.json drops settings only', () => {
    const files = planProfileFiles(sampleState());
    files['settings.json'] = 'garbage{';
    const state = assembleProfile(files).state;
    expect(state).not.toBeNull();
    expect(state?.settings).toBeUndefined();
  });
});

describe('isSafeEntityId', () => {
  it('accepts the generated id shapes', () => {
    for (const id of ['ws-m3k2-1-ab9x', 's-m3k2-2-77qq', 'swarm-1', 'a.b_c']) {
      expect(isSafeEntityId(id)).toBe(true);
    }
  });
  it('rejects path escapes', () => {
    for (const id of ['', '.', '..', '../x', 'a/b', 'a\\..\\b', '.hidden']) {
      expect(isSafeEntityId(id)).toBe(false);
    }
  });
});
