import { useState } from 'react';
import {
  parseBundle,
  type ChorusBundle,
  type ImportMode,
  type ImportResult,
} from '@app/core';
import { downloadTextFile, pickTextFile } from './file-io.js';

export interface ExportPayload {
  filename: string;
  body: string;
}

export interface MemoryControlsProps {
  /** Produce the bytes for an export, or an error message. */
  onExport: (
    layer: 'workspace' | 'full',
  ) => Promise<ExportPayload | { error: string }>;
  /** Apply a validated bundle import; resolves to a user-facing summary. */
  onImport: (bundle: ChorusBundle, mode: ImportMode) => Promise<ImportResult>;
  /** Layer-2 (conversations + memory) available — Electron only. */
  fullSupported: boolean;
}

type Notice = { kind: 'error' | 'info'; text: string };

const btn: React.CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '4px 10px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
};

/**
 * Header controls for portable Chorus bundles (PRD Epic 11). Export downloads a
 * `.chorus` file; import reads one, validates it, and offers merge-or-replace.
 * Pure DOM file I/O for Layer 1 (works in both hosts); the "full" export/import
 * is shown only when the host injected a `SessionArchive` (`fullSupported`).
 */
export function MemoryControls({
  onExport,
  onImport,
  fullSupported,
}: MemoryControlsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<{ bundle: ChorusBundle; name: string } | null>(
    null,
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const flash = (n: Notice) => {
    setNotice(n);
    setTimeout(() => setNotice((cur) => (cur === n ? null : cur)), 6000);
  };

  const doExport = async (layer: 'workspace' | 'full') => {
    setMenuOpen(false);
    setBusy(true);
    try {
      const r = await onExport(layer);
      if ('error' in r) flash({ kind: 'error', text: r.error });
      else downloadTextFile(r.filename, r.body);
    } finally {
      setBusy(false);
    }
  };

  const doPickImport = async () => {
    const picked = await pickTextFile();
    if (!picked) return;
    const parsed = parseBundle(picked.text);
    if (!parsed.ok) {
      flash({ kind: 'error', text: `Couldn't import “${picked.name}”: ${parsed.error}` });
      return;
    }
    setPending({ bundle: parsed.bundle, name: picked.name });
  };

  const applyImport = async (mode: ImportMode) => {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await onImport(pending.bundle, mode);
      setPending(null);
      const parts = [
        result.workspaceImported ? 'workspace restored' : 'workspace unchanged',
      ];
      if (result.conversationsImported || result.conversationsSkipped) {
        parts.push(
          `${result.conversationsImported} conversation(s) imported, ${result.conversationsSkipped} skipped`,
        );
      }
      const text = [parts.join('; '), ...result.warnings].join(' · ');
      flash({ kind: result.warnings.length ? 'info' : 'info', text });
    } catch (e) {
      setPending(null);
      flash({ kind: 'error', text: `Import failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const hasConversations = (pending?.bundle.conversations?.length ?? 0) > 0;

  return (
    <div style={{ position: 'relative', display: 'flex', gap: 6, alignItems: 'center' }}>
      <div style={{ position: 'relative' }}>
        <button
          style={btn}
          disabled={busy}
          title="Export this setup to a .chorus file"
          onClick={() => (fullSupported ? setMenuOpen((o) => !o) : doExport('workspace'))}
        >
          ⤓ Export{fullSupported ? ' ▾' : ''}
        </button>
        {menuOpen && fullSupported && (
          <div
            style={{
              position: 'absolute',
              top: '110%',
              right: 0,
              zIndex: 20,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 4,
              minWidth: 220,
              boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
            }}
          >
            <MenuItem onClick={() => doExport('workspace')} title="Layouts, panes, cwds, names, swarms">
              Workspace only
            </MenuItem>
            <MenuItem
              onClick={() => doExport('full')}
              title="Workspace + Claude conversations + memory files"
            >
              Full (with conversations)
            </MenuItem>
          </div>
        )}
      </div>

      <button style={btn} disabled={busy} title="Import a .chorus file" onClick={doPickImport}>
        ⤒ Import
      </button>

      {notice && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: '120%',
            right: 0,
            zIndex: 25,
            maxWidth: 360,
            background: notice.kind === 'error' ? 'var(--status-waiting)' : 'var(--bg-elevated)',
            color: notice.kind === 'error' ? 'var(--crust)' : 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 12,
            boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
          }}
        >
          {notice.text}
        </div>
      )}

      {pending && (
        <ImportDialog
          name={pending.name}
          hasConversations={hasConversations}
          busy={busy}
          onCancel={() => setPending(null)}
          onChoose={applyImport}
        />
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        color: 'var(--fg)',
        border: 'none',
        borderRadius: 6,
        padding: '7px 10px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 12,
      }}
    >
      {children}
    </button>
  );
}

function ImportDialog({
  name,
  hasConversations,
  busy,
  onCancel,
  onChoose,
}: {
  name: string;
  hasConversations: boolean;
  busy: boolean;
  onCancel: () => void;
  onChoose: (mode: ImportMode) => void;
}) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: '92%',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          color: 'var(--fg)',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 14 }}>Import “{name}”</div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
          {hasConversations
            ? 'Restores the workspace and the Claude Code conversation context (and remembered edits) — '
            : 'Restores the workspace layout, panes and names — '}
          <strong style={{ color: 'var(--fg)' }}>not</strong> the working-tree files
          themselves. Existing transcripts are never overwritten without confirmation.
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button
            style={{ ...btn, flex: 1, padding: '8px 12px' }}
            disabled={busy}
            title="Add the imported workspaces alongside your current ones"
            onClick={() => onChoose('merge')}
          >
            Merge
          </button>
          <button
            style={{
              flex: 1,
              padding: '8px 12px',
              background: 'var(--accent)',
              color: 'var(--crust)',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 600,
            }}
            disabled={busy}
            title="Replace all current workspaces with the imported setup"
            onClick={() => onChoose('replace')}
          >
            Replace all
          </button>
          <button style={{ ...btn, padding: '8px 12px' }} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
