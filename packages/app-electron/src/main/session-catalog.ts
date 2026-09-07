/**
 * Main-process reader for the machine's Claude Code session store. Lives here
 * because only main can touch `~/.claude`; the renderer sees it through
 * `SessionCatalog` over IPC.
 *
 * Two sources:
 *  - the transcript tree (`~/.claude/projects/<slug>/<id>.jsonl`) for the list;
 *  - `claude agents --json` for which of those conversations is live right now.
 *
 * Every call is best-effort: a missing store, an unreadable file or an old CLI
 * degrades to fewer rows, never to a throw across IPC.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  HEAD_BYTES,
  TAIL_BYTES,
  parseLiveSessions,
  parseSessionMeta,
  type LiveSession,
  type SessionMeta,
} from '@app/core';

/**
 * `~/.claude`, or `$CLAUDE_CONFIG_DIR` when the user has moved it (the CLI's
 * documented override).
 */
function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override ? override : path.join(os.homedir(), '.claude');
}

function projectsRoot(): string {
  return path.join(claudeConfigDir(), 'projects');
}

/**
 * Parsed rows keyed by transcript path, revalidated on mtime+size. Re-listing is
 * then a stat-only walk. Deliberately in-memory rather than a file under
 * `~/.chorus/cache`: a cold full parse of a 200 MB store measures ~0.2 s, which
 * a disk cache would not meaningfully beat — and would add a second on-disk
 * format to version and invalidate.
 */
const cache = new Map<string, { mtime: number; bytes: number; meta: SessionMeta }>();

/** Read only the two ends of a transcript — see HEAD_BYTES/TAIL_BYTES. */
async function readHeadTail(
  file: string,
  bytes: number,
): Promise<{ head: string; tail: string }> {
  const fh = await fs.open(file, 'r');
  try {
    const headLen = Math.min(HEAD_BYTES, bytes);
    const headBuf = Buffer.alloc(headLen);
    if (headLen > 0) await fh.read(headBuf, 0, headLen, 0);
    let tail = '';
    if (bytes > headLen) {
      const tailLen = Math.min(TAIL_BYTES, bytes - headLen);
      const tailBuf = Buffer.alloc(tailLen);
      await fh.read(tailBuf, 0, tailLen, bytes - tailLen);
      tail = tailBuf.toString('utf8');
    }
    return { head: headBuf.toString('utf8'), tail };
  } finally {
    await fh.close();
  }
}

interface Candidate {
  id: string;
  path: string;
  bytes: number;
  mtime: number;
}

/** Every `.jsonl` under the projects tree, with its stat. Unreadable dirs skipped. */
async function listTranscripts(): Promise<Candidate[]> {
  const root = projectsRoot();
  let slugs: string[];
  try {
    slugs = await fs.readdir(root);
  } catch {
    return []; // no Claude Code store on this machine
  }
  const out: Candidate[] = [];
  for (const slug of slugs) {
    const dir = path.join(root, slug);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const st = await fs.stat(path.join(dir, f));
        if (!st.isFile() || st.size === 0) continue;
        out.push({
          id: f.replace(/\.jsonl$/, ''),
          path: path.join(dir, f),
          bytes: st.size,
          mtime: st.mtimeMs,
        });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  return out;
}

/** Run `work` over `items` with at most `width` in flight. */
async function pooled<T, R>(
  items: T[],
  width: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * The machine's readable sessions, newest first. `limit` caps how many of the
 * newest transcripts are parsed — the stat walk is cheap, the parse is what we
 * bound. Sessions whose transcript carries no cwd are dropped (they can't be
 * resumed, since `--resume` is scoped to the conversation's own directory).
 */
export async function listSessions(limit = 400): Promise<SessionMeta[]> {
  try {
    const files = await listTranscripts();
    files.sort((a, b) => b.mtime - a.mtime);
    const newest = files.slice(0, Math.max(0, limit));

    const metas = await pooled(newest, 16, async (f) => {
      const hit = cache.get(f.path);
      if (hit && hit.mtime === f.mtime && hit.bytes === f.bytes) return hit.meta;
      try {
        const { head, tail } = await readHeadTail(f.path, f.bytes);
        const meta = parseSessionMeta(head, tail, f);
        if (meta) cache.set(f.path, { mtime: f.mtime, bytes: f.bytes, meta });
        return meta;
      } catch {
        return null;
      }
    });

    return metas.filter((m): m is SessionMeta => m !== null);
  } catch {
    return [];
  }
}

/**
 * Conversations with a live `claude` process. Runs through a login shell for the
 * same reason panes do: a GUI-launched Electron app inherits a minimal PATH and
 * would not otherwise find `claude`. A non-zero exit (older CLI without
 * `agents --json`) degrades to "nothing marked live".
 */
export function liveSessions(): Promise<LiveSession[]> {
  const shell = process.env.SHELL || '/bin/bash';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-l', '-c', 'claude agents --json'],
      { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        resolve(err ? [] : parseLiveSessions(stdout));
      },
    );
  });
}
