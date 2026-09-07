/**
 * /trace HTTP route — the browser host's window onto a pane's Claude Code
 * transcript, so the SESSION TRACE panel works outside Electron.
 *
 * Request/response fits a byte-range read far better than the PTY websocket (no
 * correlation ids, no wait-for-open race), so the dev server speaks both, same
 * as it already does for /state.
 *
 * The route is a byte reader and nothing more — parsing lives in `@app/core`
 * and runs in the browser, exactly as it does in Electron's renderer. That is
 * what keeps the two hosts from drifting apart.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type http from 'node:http';
import { claudeProjectSlug, TRACE_WINDOW_BYTES, type TraceSlice } from '@app/core';

// Vite serves the page from a different port than this server — permissive
// CORS is fine for a localhost dev harness (mirrors state-http.ts).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
} as const;

/** Expand `~` and fall back to $HOME so a bad cwd never throws (mirrors main). */
function resolveBase(input: string): string {
  const home = os.homedir();
  let c = (input ?? '').trim();
  if (!c || c === '~' || c === '~/') return home;
  if (c.startsWith('~/')) c = path.join(home, c.slice(2));
  else if (!path.isAbsolute(c)) c = path.resolve(home, c);
  return c;
}

function projectsDir(absCwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(absCwd));
}

async function readSlice(
  file: string,
  from: number | undefined,
  maxBytes: number,
): Promise<TraceSlice | null> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return { text: '', start: 0, end: 0, size: 0 };
    // No `from` means "the tail". A `from` past EOF means the file was truncated
    // or replaced under us — fall back to the tail rather than read nothing.
    const wantsTail = from === undefined || from < 0 || from > size;
    const start = wantsTail ? Math.max(0, size - maxBytes) : from;
    const length = Math.min(maxBytes, size - start);
    if (length <= 0) return { text: '', start: size, end: size, size };
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return {
      text: buf.subarray(0, bytesRead).toString('utf8'),
      start,
      end: start + bytesRead,
      size,
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Handle `GET/OPTIONS /trace?id=<sessionId>&cwd=<dir>&from=<byte>&max=<bytes>`.
 * Returns false when the URL is not /trace so the caller can 404. A missing
 * transcript answers 204 (nothing to trace yet) rather than an error — the panel
 * polls this, and a not-yet-written file is the normal case, not a fault.
 */
export async function handleTraceRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/trace') return false;
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end();
    return true;
  }

  const id = url.searchParams.get('id') ?? '';
  const cwd = url.searchParams.get('cwd') ?? '';
  // The id names a file and arrives from the client; refuse anything that could
  // climb out of the project directory.
  if (!id || !cwd || /[/\\]|\.\./.test(id)) {
    res.statusCode = 400;
    res.end();
    return true;
  }

  const fromRaw = url.searchParams.get('from');
  const from = fromRaw === null ? undefined : Number(fromRaw);
  const maxRaw = Number(url.searchParams.get('max'));
  const maxBytes = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : TRACE_WINDOW_BYTES;

  const slice = await readSlice(
    path.join(projectsDir(resolveBase(cwd)), `${id}.jsonl`),
    Number.isFinite(from) ? from : undefined,
    maxBytes,
  );

  if (!slice) {
    res.statusCode = 204;
    res.end();
    return true;
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(slice));
  return true;
}
