import type { Disposable, PtyBackend, SpawnOptions } from '@app/core';
import type { ClientMsg, ServerMsg } from './protocol.js';

type DataCb = (data: string) => void;
type ExitCb = (exitCode: number) => void;

/**
 * Browser-side `PtyBackend` for the dev harness: marshals the core PtyBackend
 * calls over the websocket bridge to the node-pty server. Supports multiple
 * onData/onExit listeners per session (the SessionManager subscribes for status
 * while the UI subscribes for rendering). See PRD Epic 2.
 */
export class WebPtyBackend implements PtyBackend {
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;
  private readonly outbox: string[] = [];
  private readonly dataCbs = new Map<string, Set<DataCb>>();
  private readonly exitCbs = new Map<string, Set<ExitCb>>();

  constructor(url: string) {
    this.ws = new WebSocket(url);

    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => {
        for (const raw of this.outbox.splice(0)) this.ws.send(raw);
        resolve();
      });
      this.ws.addEventListener('error', () => reject(new Error('ws error')));
    });

    this.ws.addEventListener('message', (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === 'data') {
        this.dataCbs.get(msg.sessionId)?.forEach((cb) => cb(msg.data));
      } else if (msg.type === 'exit') {
        this.exitCbs.get(msg.sessionId)?.forEach((cb) => cb(msg.exitCode));
      }
    });
  }

  async spawn(opts: SpawnOptions): Promise<void> {
    await this.ready;
    this.send({
      type: 'spawn',
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      shell: opts.shell,
      command: opts.command,
      env: opts.env,
    });
  }

  write(sessionId: string, data: string): void {
    this.send({ type: 'input', sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.send({ type: 'resize', sessionId, cols, rows });
  }

  kill(sessionId: string): void {
    this.send({ type: 'kill', sessionId });
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

  private send(msg: ClientMsg): void {
    const raw = JSON.stringify(msg);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      this.outbox.push(raw);
    }
  }
}
