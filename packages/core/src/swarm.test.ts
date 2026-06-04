import { describe, expect, it } from 'vitest';
import {
  broadcastTargets,
  broadcastTo,
  buildBlackboardDoc,
  buildSeedPrompt,
  formatBroadcast,
  planFanOut,
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

describe('buildSeedPrompt', () => {
  it('includes task, role, and the blackboard path', () => {
    const seed = buildSeedPrompt(def(), def().members[0], '/tmp/swarm');
    expect(seed).toContain('Feature X');
    expect(seed).toContain('Ship the login flow');
    expect(seed).toContain('frontend');
    expect(seed).toContain('/tmp/swarm/CHORUS_SWARM.md');
  });

  it('notes when no blackboard is available', () => {
    const seed = buildSeedPrompt(def(), def().members[2], null);
    expect(seed).toContain('No shared blackboard');
  });

  it('an explicit member.seedPrompt overrides the template', () => {
    const m = { sessionId: 'a', role: 'frontend', seedPrompt: 'Just do the CSS.' };
    expect(buildSeedPrompt(def(), m, '/tmp/x')).toBe('Just do the CSS.');
  });
});

describe('buildBlackboardDoc', () => {
  it('contains the task, roster, and a Log section', () => {
    const doc = buildBlackboardDoc(def());
    expect(doc).toContain('# Feature X — Chorus swarm');
    expect(doc).toContain('Ship the login flow');
    expect(doc).toContain('frontend');
    expect(doc).toContain('## Log');
  });
});

describe('planFanOut', () => {
  it('produces one seed per member, keyed by session id', () => {
    const plan = planFanOut(def(), '/tmp/swarm');
    expect(plan.map((p) => p.sessionId)).toEqual(['a', 'b', 'c']);
    expect(plan[0].seed).toContain('frontend');
    expect(plan[1].seed).toContain('backend');
  });
});
