import { describe, expect, it } from 'vitest';
import {
  buildVoiceWrite,
  cleanTranscript,
  DEFAULT_VOICE_SETTINGS,
  routeVoiceTranscript,
  type Transcriber,
  type TranscriptionChunk,
} from './voice.js';

describe('cleanTranscript', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanTranscript('  hello   world \n')).toBe('hello world');
  });
  it('returns empty for whitespace-only input', () => {
    expect(cleanTranscript('   \n\t ')).toBe('');
  });
});

describe('buildVoiceWrite', () => {
  it('insert mode does not append a newline', () => {
    expect(buildVoiceWrite('refactor the parser', 'insert')).toBe('refactor the parser');
  });
  it('submit mode appends a carriage return', () => {
    expect(buildVoiceWrite('run the tests', 'submit')).toBe('run the tests\r');
  });
  it('returns null for an empty transcript (never sends a blank line)', () => {
    expect(buildVoiceWrite('   ', 'submit')).toBeNull();
  });
});

describe('routeVoiceTranscript', () => {
  it('routes to the focused session in insert mode', () => {
    expect(routeVoiceTranscript('hi there', 'insert', 's1')).toEqual({
      sessionId: 's1',
      data: 'hi there',
    });
  });
  it('appends Enter in submit mode', () => {
    expect(routeVoiceTranscript('go', 'submit', 's1')).toEqual({
      sessionId: 's1',
      data: 'go\r',
    });
  });
  it('is a no-op when no pane is focused (US-9.1)', () => {
    expect(routeVoiceTranscript('anything', 'submit', null)).toBeNull();
  });
  it('is a no-op when nothing was transcribed', () => {
    expect(routeVoiceTranscript('  ', 'insert', 's1')).toBeNull();
  });
});

describe('Transcriber seam (fake) drives routing end-to-end', () => {
  // A fake engine that "hears" a fixed phrase, exercising the seam shape.
  class FakeTranscriber implements Transcriber {
    readonly id = 'whisper-wasm' as const;
    private chunks: TranscriptionChunk[] = [];
    constructor(private readonly phrase: string) {}
    async isAvailable() {
      return true;
    }
    async start(onChunk: (c: TranscriptionChunk) => void) {
      this.chunks = [{ text: this.phrase, isFinal: true }];
      onChunk(this.chunks[0]);
    }
    async stop() {
      return this.chunks.map((c) => c.text).join('');
    }
    cancel() {
      this.chunks = [];
    }
  }

  it('a captured phrase routes to the focused session with submit', async () => {
    const t = new FakeTranscriber(' deploy now ');
    let heard = '';
    await t.start((c) => (heard = c.text));
    const final = await t.stop();
    expect(heard).toBe(' deploy now ');
    expect(routeVoiceTranscript(final, 'submit', 'focused')).toEqual({
      sessionId: 'focused',
      data: 'deploy now\r',
    });
  });

  it('cancel discards the transcript', async () => {
    const t = new FakeTranscriber('oops');
    await t.start(() => {});
    t.cancel();
    expect(await t.stop()).toBe('');
  });
});

describe('DEFAULT_VOICE_SETTINGS', () => {
  it('defaults to the on-device WASM engine in insert mode', () => {
    expect(DEFAULT_VOICE_SETTINGS.engineId).toBe('whisper-wasm');
    expect(DEFAULT_VOICE_SETTINGS.mode).toBe('insert');
  });
});
