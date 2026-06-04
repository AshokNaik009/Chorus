/**
 * Speech-to-text seam + pure routing logic. See PRD Epic 9.
 *
 * Mic capture lives in the renderer; the captured audio is handed to an injected
 * `Transcriber`. Both shipped engines run FULLY ON-DEVICE with no keys or network
 * calls beyond a one-time model download: `whisper-wasm` (renderer, both hosts,
 * default) and `whisper-local` (Electron sidecar). No cloud STT — ever.
 *
 * The routing of a finished transcript into the focused session (insert vs submit,
 * the no-focus guard) is pure and lives here so it is unit-testable without a mic.
 */
import type { TranscriberId, VoiceSettings } from './models.js';

/** An incremental or final transcription result. */
export interface TranscriptionChunk {
  text: string;
  isFinal: boolean;
}

/**
 * A swappable transcription engine. The host injects a concrete implementation;
 * `@app/ui` consumes only this interface and never imports an STT library.
 */
export interface Transcriber {
  readonly id: TranscriberId;
  /** Whether this engine can run here (binary present, WASM supported, …). */
  isAvailable(): Promise<boolean>;
  /** Begin consuming mic audio, streaming chunks until `stop`/`cancel`. */
  start(onChunk: (c: TranscriptionChunk) => void): Promise<void>;
  /** Stop capture and resolve the final transcript. */
  stop(): Promise<string>;
  /** Abort capture immediately, discarding any pending transcript. */
  cancel(): void;
}

/** Sensible defaults; persisted/overridden via `Persistence` (US-9.3). */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  engineId: 'whisper-wasm',
  mode: 'insert',
  hotkey: 'CmdOrCtrl+Shift+D',
};

/** Whisper output often has leading/trailing whitespace; normalize it. */
export function cleanTranscript(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Turn a finished transcript into the bytes to write to a PTY. In `submit` mode a
 * trailing carriage return is appended (Enter → the prompt is sent); in `insert`
 * mode it is not (the user edits first). Returns null when nothing was said, so an
 * empty transcript never sends a blank line.
 */
export function buildVoiceWrite(
  transcript: string,
  mode: VoiceSettings['mode'],
): string | null {
  const text = cleanTranscript(transcript);
  if (!text) return null;
  return mode === 'submit' ? `${text}\r` : text;
}

/**
 * Route a transcript to the focused session. Returns null (a no-op) when no pane
 * is focused (US-9.1) or nothing was transcribed — the UI also disables the mic
 * control without focus, this is the matching guard in pure logic.
 */
export function routeVoiceTranscript(
  transcript: string,
  mode: VoiceSettings['mode'],
  focusedSessionId: string | null,
): { sessionId: string; data: string } | null {
  if (!focusedSessionId) return null;
  const data = buildVoiceWrite(transcript, mode);
  if (data === null) return null;
  return { sessionId: focusedSessionId, data };
}
