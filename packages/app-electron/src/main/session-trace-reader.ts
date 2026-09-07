/**
 * Main-process byte reader for ONE pane's transcript, feeding the SESSION TRACE
 * panel. Sibling of `session-catalog.ts`: that one walks the whole store to
 * answer "which conversations exist", this one reads the body of a single file.
 *
 * Deliberately dumb. It resolves a path, reads a byte window, and reports where
 * that window sits — every parsing rule lives in `@app/core`'s `session-trace`,
 * where it is testable without a filesystem. The same reader backs the web host
 * over HTTP, so keeping it parse-free is what stops the two hosts diverging.
 *
 * Best-effort throughout: a missing transcript, a vanished file, or a bad offset
 * degrades to null, never to a throw across IPC.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { TRACE_WINDOW_BYTES, type TraceRequest, type TraceSlice } from '@app/core';

/**
 * Read a window of a transcript.
 *
 * With no `from`, this returns the file's TAIL — the newest `maxBytes` — because
 * a trace opens on what just happened, not on a session's ancient history.
 * `start` tells the caller whether byte 0 is included, which is what lets the
 * parser know to discard a first line that the offset cut mid-JSON.
 *
 * Passing back the previous `end` as `from` yields only what was appended since,
 * which is how the panel follows a running session for the cost of the delta.
 */
export async function readTrace(
  projectsDirFor: (cwd: string) => string,
  req: TraceRequest,
): Promise<TraceSlice | null> {
  const { claudeSessionId, cwd } = req;
  // A conversation id names a file; refuse anything that could climb out of the
  // project directory, since the id reaches us from the renderer.
  if (!claudeSessionId || /[/\\]|\.\./.test(claudeSessionId)) return null;

  const file = path.join(projectsDirFor(cwd), `${claudeSessionId}.jsonl`);
  const maxBytes = Math.max(1, req.maxBytes ?? TRACE_WINDOW_BYTES);

  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return null; // no transcript yet — the pane hasn't written one.
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return { text: '', start: 0, end: 0, size: 0 };

    // No `from` means "the tail"; a `from` past EOF means the file was truncated
    // or replaced under us, so fall back to the tail rather than read nothing.
    const requested = req.from;
    const wantsTail = requested === undefined || requested < 0 || requested > size;
    const start = wantsTail ? Math.max(0, size - maxBytes) : requested;
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
