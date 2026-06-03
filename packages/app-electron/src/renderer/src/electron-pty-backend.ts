import type { Disposable, PtyBackend, SpawnOptions } from '@app/core';
import type { PaneApi } from '../../shared/ipc.js';

type DataCb = (data: string) => void;
type ExitCb = (exitCode: number) => void;

/**
 * Renderer-side `PtyBackend` for Electron: marshals core's terminal calls to the
 * main process over the preload's `paneApi` (IPC). The main->renderer streams
 * carry every session, so we fan out by `sessionId` to per-session listeners —
 * the same shape as app-web's WebPtyBackend, just a different transport.
 */
export class ElectronPtyBackend implements PtyBackend {
  private readonly dataCbs = new Map<string, Set<DataCb>>();
  private readonly exitCbs = new Map<string, Set<ExitCb>>();

  constructor(private readonly api: PaneApi) {
    api.onData(({ sessionId, data }) =>
      this.dataCbs.get(sessionId)?.forEach((cb) => cb(data)),
    );
    api.onExit(({ sessionId, exitCode }) =>
      this.exitCbs.get(sessionId)?.forEach((cb) => cb(exitCode)),
    );
  }

  async spawn(opts: SpawnOptions): Promise<void> {
    this.api.spawn(opts);
  }

  write(sessionId: string, data: string): void {
    this.api.write(sessionId, data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.api.resize(sessionId, cols, rows);
  }

  kill(sessionId: string): void {
    this.api.kill(sessionId);
  }

  onData(sessionId: string, cb: DataCb): Disposable {
    return this.subscribe(this.dataCbs, sessionId, cb);
  }

  onExit(sessionId: string, cb: ExitCb): Disposable {
    return this.subscribe(this.exitCbs, sessionId, cb);
  }

  private subscribe<C>(
    map: Map<string, Set<C>>,
    sessionId: string,
    cb: C,
  ): Disposable {
    let set = map.get(sessionId);
    if (!set) {
      set = new Set<C>();
      map.set(sessionId, set);
    }
    set.add(cb);
    return {
      dispose: () => {
        set?.delete(cb);
        if (set && set.size === 0) map.delete(sessionId);
      },
    };
  }
}
