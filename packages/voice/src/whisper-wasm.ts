import type { Transcriber, TranscriptionChunk } from '@app/core';
import { decodeToMono16k } from './audio.js';

/**
 * `whisper-wasm` — the default, fully on-device transcription engine (PRD Epic 9).
 *
 * Mic audio is captured with `MediaRecorder`, decoded locally, and transcribed by
 * an in-renderer WASM Whisper from transformers.js. The model is lazy-loaded from
 * the Hugging Face / jsDelivr CDN on first use (a one-time weights download, then
 * cached by the browser); swap `moduleUrl`/`model` for a bundled copy to ship
 * fully offline (PRD §7). No API key, no account, and the audio never leaves the
 * machine — there is no cloud STT anywhere in this path.
 */

// jsDelivr's `/+esm` endpoint returns a ready-to-import ESM bundle (the bare
// package URL does not resolve to a usable module).
const DEFAULT_MODULE_URL =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.2.4/+esm';
// Canonical transformers.js model. `tiny.en` is small + fast for a snappy first
// run (English); swap for 'Xenova/whisper-base' for multilingual/accuracy.
const DEFAULT_MODEL = 'Xenova/whisper-tiny.en';

type WhisperPipeline = (
  audio: Float32Array,
  opts?: Record<string, unknown>,
) => Promise<{ text?: string }>;

// Indirection so TS/Vite treat the specifier as runtime-dynamic (a CDN URL),
// not a bundled module to resolve at build time.
function importModule(url: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;
}

export interface WhisperWasmOptions {
  /** Override the transformers.js ESM module URL (or a bundled path). */
  moduleUrl?: string;
  /** Override the model id (e.g. 'onnx-community/whisper-tiny' for speed). */
  model?: string;
  /** Optional language hint (BCP-47, e.g. 'en'). */
  language?: string;
  /** Reports 0..1 progress during the one-time model-weights download. */
  onModelProgress?: (ratio: number) => void;
}

export class WhisperWasmTranscriber implements Transcriber {
  readonly id = 'whisper-wasm' as const;

  private pipe: WhisperPipeline | null = null;
  private pipePromise: Promise<WhisperPipeline> | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private cancelled = false;

  constructor(private readonly opts: WhisperWasmOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined' &&
      typeof OfflineAudioContext !== 'undefined' &&
      (typeof isSecureContext === 'undefined' || isSecureContext)
    );
  }

  async start(onChunk: (c: TranscriptionChunk) => void): Promise<void> {
    this.cancelled = false;
    this.chunks = [];
    // Warm the model in parallel with capture so stop() returns faster.
    void this.ensurePipeline();

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.cancelled) {
      this.releaseStream();
      return;
    }
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
    // We transcribe on stop, so signal "listening" with an empty interim chunk.
    onChunk({ text: '', isFinal: false });
  }

  async stop(): Promise<string> {
    if (!this.recorder) {
      this.release();
      return '';
    }
    const blob = await this.finishRecording();
    this.releaseStream();
    this.recorder = null;
    if (this.cancelled || blob.size === 0) return '';

    const audio = await decodeToMono16k(blob);
    const pipe = await this.ensurePipeline();
    const result = await pipe(
      audio,
      this.opts.language ? { language: this.opts.language } : undefined,
    );
    return (result?.text ?? '').trim();
  }

  cancel(): void {
    this.cancelled = true;
    try {
      this.recorder?.stop();
    } catch {
      /* already stopped */
    }
    this.release();
  }

  private finishRecording(): Promise<Blob> {
    const rec = this.recorder;
    if (!rec) return Promise.resolve(new Blob(this.chunks));
    return new Promise((resolve) => {
      rec.addEventListener(
        'stop',
        () => resolve(new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' })),
        { once: true },
      );
      try {
        rec.stop();
      } catch {
        resolve(new Blob(this.chunks));
      }
    });
  }

  private ensurePipeline(): Promise<WhisperPipeline> {
    if (this.pipe) return Promise.resolve(this.pipe);
    if (this.pipePromise) return this.pipePromise;
    this.pipePromise = this.loadPipeline();
    return this.pipePromise;
  }

  private async loadPipeline(): Promise<WhisperPipeline> {
    const mod = await importModule(this.opts.moduleUrl ?? DEFAULT_MODULE_URL);
    const env = mod.env as { allowLocalModels?: boolean } | undefined;
    if (env) env.allowLocalModels = false;
    const pipeline = mod.pipeline as (
      task: string,
      model: string,
      opts?: Record<string, unknown>,
    ) => Promise<WhisperPipeline>;
    const progress = this.opts.onModelProgress;
    this.pipe = await pipeline(
      'automatic-speech-recognition',
      this.opts.model ?? DEFAULT_MODEL,
      {
        progress_callback: progress
          ? (p: { progress?: number }) => {
              if (typeof p?.progress === 'number') progress(p.progress / 100);
            }
          : undefined,
      },
    );
    return this.pipe;
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private release(): void {
    this.releaseStream();
    this.recorder = null;
    this.chunks = [];
  }
}
