import { describe, expect, it } from 'vitest';
import {
  broadcastTargets,
  broadcastTo,
  buildAgentSystemPrompt,
  formatBroadcast,
  planAgentWorktrees,
  SWARM_INTERRUPT,
  SwarmOrchestrator,
  type SwarmWriter,
} from './swarm.js';
import type { SwarmDef } from './models.js';

function def(overrides: Partial<SwarmDef> = {}): SwarmDef {
  return {
    swarmId: 'sw1',
    workspaceId: 'ws1',
    name: 'Feature X',
    task: 'Ship the login flow',
    members: [
      { sessionId: 'a', role: 'frontend' },
      { sessionId: 'b', role: 'backend' },
      { sessionId: 'c' },
    ],
    ...overrides,
  };
}

/** Records every write so we can assert on group fan-out. */
class RecordingWriter implements SwarmWriter {
  readonly writes: { sessionId: string; data: string }[] = [];
  write(sessionId: string, data: string): void {
    this.writes.push({ sessionId, data });
  }
}

describe('broadcastTargets', () => {
  it('returns every member with no allow-list', () => {
    expect(broadcastTargets(def().members)).toEqual(['a', 'b', 'c']);
  });
  it('honors an `only` allow-list', () => {
    expect(broadcastTargets(def().members, ['a', 'c'])).toEqual(['a', 'c']);
  });
  it('ignores ids not in the roster', () => {
    expect(broadcastTargets(def().members, ['a', 'zzz'])).toEqual(['a']);
  });
});

describe('formatBroadcast', () => {
  it('submit appends a carriage return', () => {
    expect(formatBroadcast('go', true)).toBe('go\r');
  });
  it('insert does not', () => {
    expect(formatBroadcast('go', false)).toBe('go');
  });
});

describe('broadcastTo', () => {
  it('writes the same payload to every target', () => {
    const w = new RecordingWriter();
    broadcastTo(w, ['a', 'b'], 'status?', true);
    expect(w.writes).toEqual([
      { sessionId: 'a', data: 'status?\r' },
      { sessionId: 'b', data: 'status?\r' },
    ]);
  });
});

describe('SwarmOrchestrator', () => {
  it('broadcast targets all members of the looked-up swarm', () => {
    const w = new RecordingWriter();
    const o = new SwarmOrchestrator(w, (id) => (id === 'sw1' ? def() : undefined));
    o.broadcast('sw1', 'hello', { submit: false });
    expect(w.writes.map((x) => x.sessionId)).toEqual(['a', 'b', 'c']);
    expect(w.writes.every((x) => x.data === 'hello')).toBe(true);
  });

  it('broadcast respects `only`', () => {
    const w = new RecordingWriter();
    const o = new SwarmOrchestrator(w, () => def());
    o.broadcast('sw1', 'ping', { submit: true, only: ['b'] });
    expect(w.writes).toEqual([{ sessionId: 'b', data: 'ping\r' }]);
  });

  it('broadcast is a no-op for an unknown swarm', () => {
    const w = new RecordingWriter();
    const o = new SwarmOrchestrator(w, () => undefined);
    o.broadcast('missing', 'x', { submit: true });
    expect(w.writes).toEqual([]);
  });

  it('stopAll sends Ctrl-C to every member', () => {
    const w = new RecordingWriter();
    const o = new SwarmOrchestrator(w, () => def());
    o.stopAll('sw1');
    expect(w.writes).toEqual([
      { sessionId: 'a', data: SWARM_INTERRUPT },
      { sessionId: 'b', data: SWARM_INTERRUPT },
      { sessionId: 'c', data: SWARM_INTERRUPT },
    ]);
  });
});

describe('buildAgentSystemPrompt', () => {
  it('frames the role/context and pins the agent to its isolated worktree', () => {
    const sp = buildAgentSystemPrompt(
      'Feature X',
      'frontend',
      'Ship the login flow',
      '/work/feature-x/frontend',
      true,
    );
    expect(sp).toContain('"frontend"');
    expect(sp).toContain('Feature X');
    expect(sp).toContain('Ship the login flow');
    expect(sp).toContain('/work/feature-x/frontend');
    expect(sp).toContain('relative paths');
    expect(sp).toContain('isolated git branch');
    expect(sp).toContain('acceptance criteria');
  });

  it('tells a shared-dir agent the truth (no worktree) and still pins the dir', () => {
    const sp = buildAgentSystemPrompt('Feature X', undefined, undefined, '/tmp/shared', false);
    expect(sp).toContain('an agent in the Chorus swarm "Feature X"');
    expect(sp).toContain('/tmp/shared');
    expect(sp).toContain('share this directory');
    expect(sp).not.toContain('isolated git branch');
  });
});

describe('planAgentWorktrees', () => {
  it('produces a unique branch + subdir per role', () => {
    const plan = planAgentWorktrees('Feature X', ['frontend', 'backend']);
    expect(plan[0].branch).toBe('chorus/feature-x/frontend');
    expect(plan[0].worktreeSubdir).toBe('feature-x/frontend');
    expect(plan[1].branch).toBe('chorus/feature-x/backend');
  });

  it('disambiguates duplicate / empty roles', () => {
    const plan = planAgentWorktrees('S', ['dev', 'dev', '']);
    const branches = plan.map((p) => p.branch);
    expect(new Set(branches).size).toBe(3);
    expect(branches[1]).toBe('chorus/s/dev-2');
  });
});
