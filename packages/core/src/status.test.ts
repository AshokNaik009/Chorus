import { describe, expect, it } from 'vitest';
import { INITIAL_STATUS, statusReducer, type StatusEvent } from './status';
import type { SessionStatus } from './models';

/** Fold a sequence of events from a starting state. */
function run(
  events: StatusEvent[],
  start: SessionStatus = INITIAL_STATUS,
): SessionStatus {
  return events.reduce(statusReducer, start);
}

describe('statusReducer', () => {
  it('starts spawning', () => {
    expect(INITIAL_STATUS).toBe('spawning');
  });

  it('spawn -> spawning', () => {
    expect(statusReducer('idle', { type: 'spawn' })).toBe('spawning');
  });

  it('first output after spawn -> idle (prompt ready)', () => {
    expect(run([{ type: 'spawn' }, { type: 'firstOutput' }])).toBe('idle');
  });

  it('firstOutput does not change a live, non-spawning state', () => {
    expect(statusReducer('running', { type: 'firstOutput' })).toBe('running');
    expect(statusReducer('waiting', { type: 'firstOutput' })).toBe('waiting');
  });

  it('submit while ready -> running', () => {
    expect(statusReducer('idle', { type: 'submit' })).toBe('running');
    expect(statusReducer('waiting', { type: 'submit' })).toBe('running');
  });

  it('submit before prompt is ready is ignored', () => {
    expect(statusReducer('spawning', { type: 'submit' })).toBe('spawning');
  });

  it('Notification hook -> waiting', () => {
    expect(statusReducer('running', { type: 'hook', status: 'waiting' })).toBe(
      'waiting',
    );
  });

  it('Stop hook -> idle', () => {
    expect(statusReducer('running', { type: 'hook', status: 'idle' })).toBe(
      'idle',
    );
  });

  it('hooks are authoritative over the running heuristic', () => {
    // submit says "running", but a Stop hook arriving next returns to idle
    expect(
      run([
        { type: 'firstOutput' },
        { type: 'submit' },
        { type: 'hook', status: 'idle' },
      ]),
    ).toBe('idle');
  });

  it('quiet after running -> idle (fallback)', () => {
    expect(statusReducer('running', { type: 'quiet' })).toBe('idle');
  });

  it('quiet does nothing outside running', () => {
    expect(statusReducer('idle', { type: 'quiet' })).toBe('idle');
    expect(statusReducer('waiting', { type: 'quiet' })).toBe('waiting');
    expect(statusReducer('spawning', { type: 'quiet' })).toBe('spawning');
  });

  it('exit -> exited from any state', () => {
    const states: SessionStatus[] = [
      'spawning',
      'running',
      'waiting',
      'idle',
    ];
    for (const s of states) {
      expect(statusReducer(s, { type: 'exit' })).toBe('exited');
    }
  });

  it('exited is absorbing', () => {
    const after = run(
      [
        { type: 'hook', status: 'running' },
        { type: 'submit' },
        { type: 'firstOutput' },
        { type: 'spawn' },
      ],
      'exited',
    );
    expect(after).toBe('exited');
  });

  it('models a full lifecycle: spawn -> idle -> running -> waiting -> idle -> exited', () => {
    let s = INITIAL_STATUS;
    s = statusReducer(s, { type: 'spawn' });
    expect(s).toBe('spawning');
    s = statusReducer(s, { type: 'firstOutput' });
    expect(s).toBe('idle');
    s = statusReducer(s, { type: 'submit' });
    expect(s).toBe('running');
    s = statusReducer(s, { type: 'hook', status: 'waiting' });
    expect(s).toBe('waiting');
    s = statusReducer(s, { type: 'hook', status: 'idle' });
    expect(s).toBe('idle');
    s = statusReducer(s, { type: 'exit' });
    expect(s).toBe('exited');
  });
});
