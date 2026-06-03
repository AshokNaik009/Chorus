/**
 * Dev-harness PTY bridge: a websocket server that owns node-pty processes.
 *
 * Runs in Node (never the browser). One websocket connection may drive many
 * sessions, each keyed by `sessionId`. Closing the socket kills every child
 * PTY it spawned — no orphan processes (PRD US-1.1, §8).
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { WebSocketServer, WebSocket } from 'ws';
import pty, { type IPty } from 'node-pty';
import { shellLaunchArgs } from '@app/core';
import type { ClientMsg, ServerMsg } from '../src/protocol.js';

const PORT = Number(process.env.PTY_WS_PORT ?? 3001);

function defaultShell(): string {
  if (process.platform === 'win32') return 'pwsh.exe';
  return process.env.SHELL || 'bash';
}

/**
 * node-pty does not expand `~` or resolve relative paths, and a non-existent
 * cwd makes the child exit immediately. Expand/resolve here and fall back to
 * the home directory so a bad path never kills the session.
 */
function resolveCwd(input: string | undefined): string {
  const home = os.homedir();
  let c = (input ?? '').trim();
  if (!c || c === '~' || c === '~/') return home;
  if (c.startsWith('~/')) c = path.join(home, c.slice(2));
  else if (!path.isAbsolute(c)) c = path.resolve(home, c);
  try {
    if (fs.statSync(c).isDirectory()) return c;
  } catch {
    /* fall back to home */
  }
  return home;
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  // Sessions owned by THIS connection.
  const procs = new Map<string, IPty>();

  const killAll = () => {
    for (const proc of procs.values()) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
    procs.clear();
  };

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'spawn': {
        if (procs.has(msg.sessionId)) return; // idempotent
        const shell = msg.shell || defaultShell();
        const args = shellLaunchArgs(msg.command, process.platform === 'win32');
        const proc = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: msg.cols || 80,
          rows: msg.rows || 24,
          cwd: resolveCwd(msg.cwd),
          env: { ...process.env, ...(msg.env ?? {}) } as Record<string, string>,
        });
        procs.set(msg.sessionId, proc);

        proc.onData((data) =>
          send(ws, { type: 'data', sessionId: msg.sessionId, data }),
        );
        proc.onExit(({ exitCode }) => {
          procs.delete(msg.sessionId);
          send(ws, { type: 'exit', sessionId: msg.sessionId, exitCode });
        });
        break;
      }
      case 'input':
        procs.get(msg.sessionId)?.write(msg.data);
        break;
      case 'resize':
        try {
          procs.get(msg.sessionId)?.resize(msg.cols, msg.rows);
        } catch {
          /* size transiently invalid */
        }
        break;
      case 'kill': {
        const proc = procs.get(msg.sessionId);
        if (proc) {
          proc.kill();
          procs.delete(msg.sessionId);
        }
        break;
      }
    }
  });

  ws.on('close', killAll);
  ws.on('error', killAll);
});

// eslint-disable-next-line no-console
console.log(`[pty-ws] listening on ws://localhost:${PORT}`);

const shutdown = () => {
  wss.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
