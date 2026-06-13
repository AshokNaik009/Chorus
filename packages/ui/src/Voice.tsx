import { useCallback, useEffect, useRef, useState } from 'react';
import {
  routeVoiceTranscript,
  type Transcriber,
  type TranscriberId,
  type VoiceSettings,
} from '@app/core';

/** Capture lifecycle for one pane's dictation (PRD Epic 9). */
export type VoiceStatus = 'idle' | 'recording' | 'transcribing';

function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission denied. Allow mic access to dictate.';
  }
  if (name === 'NotFoundError') return 'No microphone was found.';
  return `Could not start the microphone: ${(e as Error)?.message ?? 'unknown error'}`;
}

/**
 * Drives one transcriber through a press-to-talk (or click-toggle) capture and
 * routes the final transcript to the focused session. The mic is opened only
 * while recording and released the instant capture ends (US-9.4). All host-
 * specific work happens behind the injected `Transcriber` seam.
 */
export function useVoiceCapture(params: {
  transcriber: Transcriber | null;
  mode: VoiceSettings['mode'];
  focusedSessionId: string | null;
  /** True when the focused session is live (a PTY exists to receive text). */
  canCapture: boolean;
  write: (sessionId: string, data: string) => void;
}): {
  status: VoiceStatus;
  error: string | null;
  clearError: () => void;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  toggle: () => void;
} {
  const { transcriber, mode, focusedSessionId, canCapture, write } = params;
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef<Transcriber | null>(null);
  const targetRef = useRef<string | null>(null);

  const start = useCallback(() => {
    if (status !== 'idle') return;
    if (!transcriber || !canCapture || !focusedSessionId) return;
    targetRef.current = focusedSessionId;
    activeRef.current = transcriber;
    setError(null);
    setStatus('recording');
    transcriber.start(() => {}).catch((e) => {
      activeRef.current = null;
      targetRef.current = null;
      setStatus('idle');
      setError(micErrorMessage(e));
    });
  }, [status, transcriber, canCapture, focusedSessionId]);

  const stop = useCallback(() => {
    const t = activeRef.current;
    if (!t || status !== 'recording') return;
    setStatus('transcribing');
    t.stop()
      .then((text) => {
        const target = targetRef.current;
        const routed = routeVoiceTranscript(text, mode, target);
        if (routed) write(routed.sessionId, routed.data);
        else if (target && !text.trim()) {
          setError('No speech detected — nothing was inserted. Try speaking a bit longer.');
        }
      })
      .catch((e) => setError(`Transcription failed: ${(e as Error)?.message ?? 'error'}`))
      .finally(() => {
        activeRef.current = null;
        targetRef.current = null;
        setStatus('idle');
      });
  }, [status, mode, write]);

  const cancel = useCallback(() => {
    const t = activeRef.current;
    if (t) {
      try {
        t.cancel();
      } catch {
        /* ignore */
      }
    }
    activeRef.current = null;
    targetRef.current = null;
    setStatus('idle');
  }, []);

  const toggle = useCallback(() => {
    if (status === 'idle') start();
    else if (status === 'recording') stop();
  }, [status, start, stop]);

  // Release the mic if the component unmounts mid-capture.
  useEffect(() => () => activeRef.current?.cancel(), []);

  return { status, error, clearError: () => setError(null), start, stop, cancel, toggle };
}

// ---- hotkey matching (press-and-hold = push-to-talk) ----

interface Chord {
  meta: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** Parse "CmdOrCtrl+Shift+D" into a chord matcher. */
export function parseHotkey(hotkey: string): Chord {
  const parts = hotkey.split('+').map((p) => p.trim().toLowerCase());
  return {
    meta: parts.some((p) => p === 'cmdorctrl' || p === 'cmd' || p === 'ctrl' || p === 'control' || p === 'meta'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt') || parts.includes('option'),
    key: parts[parts.length - 1] ?? '',
  };
}

function chordHeld(e: KeyboardEvent, c: Chord): boolean {
  return (
    (e.metaKey || e.ctrlKey) === c.meta &&
    e.shiftKey === c.shift &&
    e.altKey === c.alt &&
    e.key.toLowerCase() === c.key
  );
}

/**
 * Global push-to-talk: hold the chord to record, release the primary key to stop;
 * Esc cancels. App-wide (any pane), reusing the focused-session routing.
 */
export function useVoiceHotkey(
  hotkey: string,
  api: { status: VoiceStatus; start: () => void; stop: () => void; cancel: () => void },
): void {
  const ref = useRef(api);
  ref.current = api;
  useEffect(() => {
    const chord = parseHotkey(hotkey);
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === 'Escape' && ref.current.status !== 'idle') {
        ref.current.cancel();
        return;
      }
      if (chordHeld(e, chord) && ref.current.status === 'idle') {
        e.preventDefault();
        ref.current.start();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === chord.key && ref.current.status === 'recording') {
        ref.current.stop();
      }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [hotkey]);
}

// ---- presentational ----

const micBtn = (active: boolean): React.CSSProperties => ({
  background: active ? 'var(--status-waiting)' : 'transparent',
  border: 'none',
  color: active ? 'var(--crust)' : 'var(--fg-muted)',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
  padding: '0 3px',
  borderRadius: 4,
});

/** Mic toggle shown in the focused pane header (US-9.1). */
export function VoiceMicButton({
  status,
  disabled,
  disabledReason,
  onToggle,
}: {
  status: VoiceStatus;
  disabled: boolean;
  disabledReason?: string;
  onToggle: () => void;
}) {
  const active = status !== 'idle';
  const title = disabled
    ? disabledReason ?? 'Voice unavailable'
    : status === 'recording'
      ? 'Stop & insert (or hold the hotkey)'
      : status === 'transcribing'
        ? 'Transcribing…'
        : 'Dictate into this pane';
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onToggle();
      }}
      disabled={disabled}
      title={title}
      style={{ ...micBtn(active), opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' }}
    >
      {status === 'transcribing' ? '…' : '🎙'}
    </button>
  );
}

/** Animated, fixed indicator visible only while the mic is live (US-9.4). */
export function RecordingIndicator({
  status,
  onStop,
  onCancel,
}: {
  status: VoiceStatus;
  onStop: () => void;
  onCancel: () => void;
}) {
  if (status === 'idle') return null;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 999,
        padding: '8px 14px',
        boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
        fontSize: 12,
        color: 'var(--fg)',
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: 'var(--status-waiting)',
          animation: 'chorus-pulse 1s ease-in-out infinite',
        }}
      />
      {status === 'recording'
        ? 'Listening… click Stop (or release the hotkey) to insert'
        : 'Transcribing… first run downloads the model, this can take a moment'}
      {status === 'recording' && (
        <>
          <button
            onClick={onStop}
            title="Stop & insert the transcript"
            style={{
              background: 'var(--accent)',
              border: 'none',
              color: 'var(--crust)',
              borderRadius: 6,
              padding: '3px 10px',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            ⏹ Stop
          </button>
          <button
            onClick={onCancel}
            title="Cancel (Esc)"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--fg-muted)',
              borderRadius: 6,
              padding: '3px 8px',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            Esc
          </button>
        </>
      )}
    </div>
  );
}

const ENGINE_LABELS: Record<TranscriberId, string> = {
  'whisper-wasm': 'Whisper (in-browser, WASM)',
  'whisper-local': 'Whisper (local sidecar, faster)',
};

/** Gear + dialog to pick engine/mode/language; changes persist via the caller. */
export function VoiceSettingsButton({
  transcribers,
  availableIds,
  settings,
  onChange,
}: {
  transcribers: Transcriber[];
  availableIds: Set<TranscriberId>;
  settings: VoiceSettings;
  onChange: (next: VoiceSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const engines = transcribers.filter((t) => availableIds.has(t.id));
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Voice settings"
        style={{
          background: 'var(--bg)',
          color: 'var(--fg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '4px 8px',
          cursor: 'pointer',
          fontSize: 12,
        }}
      >
        🎙 Voice
      </button>
      {open && (
        <div
          onClick={() => setOpen(false)}
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
              width: 460,
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
            <div style={{ fontWeight: 700, fontSize: 14 }}>Voice dictation</div>

            <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Engine</label>
            {engines.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--status-waiting)' }}>
                No transcription engine is available in this host.
              </div>
            ) : (
              <select
                value={settings.engineId}
                onChange={(e) =>
                  onChange({ ...settings, engineId: e.target.value as TranscriberId })
                }
                style={selectStyle}
              >
                {engines.map((t) => (
                  <option key={t.id} value={t.id}>
                    {ENGINE_LABELS[t.id]}
                  </option>
                ))}
              </select>
            )}

            <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>On finish</label>
            <select
              value={settings.mode}
              onChange={(e) =>
                onChange({ ...settings, mode: e.target.value as VoiceSettings['mode'] })
              }
              style={selectStyle}
            >
              <option value="insert">Insert (edit before sending)</option>
              <option value="submit">Submit (send the prompt)</option>
            </select>

            <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              Language (optional, e.g. en)
            </label>
            <input
              value={settings.language ?? ''}
              onChange={(e) =>
                onChange({ ...settings, language: e.target.value.trim() || undefined })
              }
              placeholder="auto-detect"
              style={{ ...selectStyle, fontFamily: 'inherit' }}
            />

            <div style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
              🔒 Transcription runs <strong style={{ color: 'var(--fg)' }}>on-device</strong>.
              Audio never leaves your machine; the first use downloads the model once,
              then works offline. Hold <code>{settings.hotkey}</code> to talk.
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: 'var(--accent)',
                  color: 'var(--crust)',
                  border: 'none',
                  borderRadius: 6,
                  padding: '7px 14px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: 12,
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 12,
};
