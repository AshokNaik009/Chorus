import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from './session-manager';
import { formatStatusOsc } from './osc';
import type { Disposable, PtyBackend, SpawnOptions } from './pty';

/** A controllable in-memory PtyBackend for tests. */
class FakeBackend implements PtyBackend {
  spawned: SpawnOptions[] = [];
  writes: { id: string; data: string }[] = [];
  killed: string[] = [];
  private dataCbs = new Map<string, Set<(d: string) => void>>();
  private exitCbs = new Map<string, Set<(c: number) => void>>();

  async spawn(opts: SpawnOptions): Promise<void> {
    this.spawned.push(opts);
  }
  write(id: string, data: string): void {
    this.writes.push({ id, data });
  }
  resize(): void {}
  kill(id: string): void {
    this.killed.push(id);
  }
  onData(id: string, cb: (d: string) => void): Disposable {
    return this.sub(this.dataCbs, id, cb);
  }
  onExit(id: string, cb: (c: number) => void): Disposable {
    return this.sub(this.exitCbs, id, cb);
  }
  emitData(id: string, d: string): void {
    this.dataCbs.get(id)?.forEach((cb) => cb(d));
  }
  emitExit(id: string, c: number): void {
    this.exitCbs.get(id)?.forEach((cb) => cb(c));
  }
  private sub<C>(map: Map<string, Set<C>>, id: string, cb: C): Disposable {
    let set = map.get(id);
    if (!set) map.set(id, (set = new Set()));
    set.add(cb);
    return { dispose: () => set!.delete(cb) };
  }
}

const config = (id: string) => ({ sessionId: id, title: id, cwd: '/tmp' });
const dims = { cols: 80, rows: 24 };

describe('SessionManager', () => {
  let backend: FakeBackend;
  let mgr: SessionManager;

  beforeEach(() => {
    backend = new FakeBackend();
    mgr = new SessionManager(backend, { fallbackIdleMs: 1000 });
  });

  it('spawns in spawning state and delegates to the backend', async () => {
    await mgr.spawn(config('a'), dims, { command: 'claude' });
    expect(mgr.get('a')?.status).toBe('spawning');
    expect(backend.spawned[0]).toMatchObject({ sessionId: 'a', command: 'claude' });
  });

  it('first output -> idle and forwards cleaned data', async () => {
    const received: string[] = [];
    mgr.onData('a', (d) => received.push(d));
    await mgr.spawn(config('a'), dims);
    backend.emitData('a', 'hello');
    expect(mgr.get('a')?.status).toBe('idle');
    expect(received.join('')).toBe('hello');
  });

  it('strips OSC status bytes from forwarded output and updates status', async () => {
    const received: string[] = [];
    mgr.onData('a', (d) => received.push(d));
    await mgr.spawn(config('a'), dims);
    backend.emitData('a', `out${formatStatusOsc('waiting')}more`);
    expect(received.join('')).toBe('outmore');
    expect(mgr.get('a')?.status).toBe('waiting');
  });

  it('submit is the primary running signal, even after a hook idle', async () => {
    await mgr.spawn(config('a'), dims);
    backend.emitData('a', formatStatusOsc('idle')); // Stop hook -> idle
    expect(mgr.get('a')?.status).toBe('idle');
    mgr.write('a', 'do something\r');
    expect(mgr.get('a')?.status).toBe('running');
  });

  it('a Notification hook overrides running -> waiting', async () => {
    await mgr.spawn(config('a'), dims);
    backend.emitData('a', 'prompt> ');
    mgr.write('a', 'hi\r');
    expect(mgr.get('a')?.status).toBe('running');
    backend.emitData('a', formatStatusOsc('waiting'));
    expect(mgr.get('a')?.status).toBe('waiting');
  });

  it('exit -> exited', async () => {
    await mgr.spawn(config('a'), dims);
    backend.emitData('a', 'x');
    backend.emitExit('a', 0);
    expect(mgr.get('a')?.status).toBe('exited');
  });

  it('remove kills the PTY and drops the session', async () => {
    await mgr.spawn(config('a'), dims);
    mgr.remove('a');
    expect(backend.killed).toContain('a');
    expect(mgr.has('a')).toBe(false);
  });

  it('emits onStatus for transitions', async () => {
    const trail: string[] = [];
    mgr.onStatus.on(({ status }) => trail.push(status));
    await mgr.spawn(config('a'), dims);
    // First chunk also triggers firstOutput (spawning -> idle) before the hook.
    backend.emitData('a', formatStatusOsc('running'));
    backend.emitData('a', formatStatusOsc('waiting'));
    backend.emitExit('a', 1);
    expect(trail).toEqual(['idle', 'running', 'waiting', 'exited']);
  });
});

describe('SessionManager fallback quiet timer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('running -> idle after a quiet period (no hooks)', async () => {
    const backend = new FakeBackend();
    const mgr = new SessionManager(backend, { fallbackIdleMs: 1000 });
    await mgr.spawn(config('a'), dims);
    backend.emitData('a', 'prompt> ');
    mgr.write('a', 'go\r');
    expect(mgr.get('a')?.status).toBe('running');
    vi.advanceTimersByTime(1000);
    expect(mgr.get('a')?.status).toBe('idle');
  });

  it('a hook cancels the pending quiet timer', async () => {
    const backend = new FakeBackend();
    const mgr = new SessionManager(backend, { fallbackIdleMs: 1000 });
    await mgr.spawn(config('a'), dims);
    backend.emitData('a', 'prompt> ');
    mgr.write('a', 'go\r'); // running + armed timer
    backend.emitData('a', formatStatusOsc('waiting')); // hook -> cancels timer
    vi.advanceTimersByTime(5000);
    expect(mgr.get('a')?.status).toBe('waiting');
  });
});
