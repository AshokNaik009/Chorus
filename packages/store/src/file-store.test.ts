import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  STORE_VERSION,
  type SessionConfig,
  type Workspace,
  type WorkspaceState,
} from '@app/core';
import { FileTreeStore, resolveChorusHome } from './file-store';

function session(id: string, title = id): SessionConfig {
  return { sessionId: id, title, cwd: '~' };
}

function workspace(id: string, sessions: SessionConfig[]): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    defaultCwd: '~/code',
    layout: { type: 'pane', sessionId: sessions[0]?.sessionId ?? 's-none' },
    sessions,
  };
}

function sampleState(): WorkspaceState {
  return {
    version: 2,
    workspaces: [
      {
        ...workspace('ws-b', [session('s-b1'), session('s-b2')]),
        mode: 'swarm',
        view: 'tabs',
        swarms: [
          {
            swarmId: 'swarm-1',
            workspaceId: 'ws-b',
            name: 'swarm one',
            members: [{ sessionId: 's-b1', role: 'backend' }],
          },
        ],
      },
      workspace('ws-a', [session('s-a1')]),
    ],
    activeWorkspaceId: 'ws-a',
  };
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.push(path.relative(root, abs));
    }
  };
  await walk(root);
  return out.sort();
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'chorus-store-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('FileTreeStore', () => {
  it('save -> fresh-instance load round-trips the state', async () => {
    const state = sampleState();
    await new FileTreeStore(root).save(state);
    const loaded = await new FileTreeStore(root).load();
    expect(loaded).toEqual(state);
  });

  it('writes the expected tree with no leftover tmp files', async () => {
    await new FileTreeStore(root).save(sampleState());
    const files = await listFiles(root);
    expect(files).toEqual([
      'state.json',
      'workspaces/ws-a/sessions/s-a1.json',
      'workspaces/ws-a/workspace.json',
      'workspaces/ws-b/sessions/s-b1.json',
      'workspaces/ws-b/sessions/s-b2.json',
      'workspaces/ws-b/swarms/swarm-1.json',
      'workspaces/ws-b/workspace.json',
    ]);
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false);
  });

  it('missing root loads as null', async () => {
    const loaded = await new FileTreeStore(path.join(root, 'nope')).load();
    expect(loaded).toBeNull();
  });

  it('only rewrites changed files on save', async () => {
    const store = new FileTreeStore(root);
    const state = sampleState();
    await store.save(state);
    const untouched = path.join(root, 'workspaces/ws-b/sessions/s-b1.json');
    const before = (await fs.stat(untouched)).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    const next = sampleState();
    next.workspaces[1].sessions[0] = session('s-a1', 'renamed');
    await store.save(next);

    expect((await fs.stat(untouched)).mtimeMs).toBe(before);
    const changed = JSON.parse(
      await fs.readFile(
        path.join(root, 'workspaces/ws-a/sessions/s-a1.json'),
        'utf8',
      ),
    );
    expect(changed.title).toBe('renamed');
  });

  it('removing a workspace deletes its files and directory', async () => {
    const store = new FileTreeStore(root);
    await store.save(sampleState());
    const next = sampleState();
    next.workspaces = next.workspaces.filter((w) => w.id !== 'ws-b');
    await store.save(next);

    const files = await listFiles(root);
    expect(files.some((f) => f.startsWith('workspaces/ws-b'))).toBe(false);
    await expect(fs.stat(path.join(root, 'workspaces/ws-b'))).rejects.toThrow();
    // the surviving workspace is intact
    expect(await new FileTreeStore(root).load()).toEqual(next);
  });

  it('skips a corrupt session file on load; the next save removes it', async () => {
    const store = new FileTreeStore(root);
    await store.save(sampleState());
    const corrupt = path.join(root, 'workspaces/ws-b/sessions/s-b1.json');
    await fs.writeFile(corrupt, 'garbage{', 'utf8');

    const fresh = new FileTreeStore(root);
    const loaded = await fresh.load();
    const b = loaded?.workspaces.find((w) => w.id === 'ws-b');
    expect(b?.sessions.map((s) => s.sessionId)).toEqual(['s-b2']);

    await fresh.save(loaded!);
    await expect(fs.stat(corrupt)).rejects.toThrow();
  });

  it('leaves unmanaged files alone across saves and deletes', async () => {
    const store = new FileTreeStore(root);
    await store.save(sampleState());
    const notes = path.join(root, 'workspaces/ws-b/notes.md');
    await fs.writeFile(notes, 'mine\n', 'utf8');

    const next = sampleState();
    next.workspaces = next.workspaces.filter((w) => w.id !== 'ws-b');
    await store.save(next);

    // the workspace dir survives because the unmanaged file keeps it alive
    expect(await fs.readFile(notes, 'utf8')).toBe('mine\n');
    // and the store no longer sees the workspace
    expect(
      (await new FileTreeStore(root).load())?.workspaces.map((w) => w.id),
    ).toEqual(['ws-a']);
  });

  it('refuses to load or save over a future storeVersion', async () => {
    await new FileTreeStore(root).save(sampleState());
    const stateJson = path.join(root, 'state.json');
    await fs.writeFile(
      stateJson,
      JSON.stringify({
        storeVersion: STORE_VERSION + 1,
        activeWorkspaceId: 'ws-a',
        workspaceOrder: ['ws-b', 'ws-a'],
      }),
      'utf8',
    );
    const filesBefore = await listFiles(root);

    const store = new FileTreeStore(root);
    expect(await store.load()).toBeNull();
    await store.save(sampleState());
    expect(await listFiles(root)).toEqual(filesBefore);
    expect(JSON.parse(await fs.readFile(stateJson, 'utf8')).storeVersion).toBe(
      STORE_VERSION + 1,
    );
  });
});

describe('resolveChorusHome', () => {
  it('honors CHORUS_HOME', () => {
    expect(resolveChorusHome({ CHORUS_HOME: '/tmp/x' })).toBe('/tmp/x');
    expect(resolveChorusHome({ CHORUS_HOME: '  ' })).toBe(
      path.join(os.homedir(), '.chorus'),
    );
    expect(resolveChorusHome({})).toBe(path.join(os.homedir(), '.chorus'));
  });
});
