/**
 * @app/voice — concrete, on-device transcription engines a host can inject.
 *
 * Depends only on `@app/core` interfaces (the `Transcriber` seam) plus browser
 * Web APIs. No cloud STT, no API keys; audio never leaves the device.
 */
export { WhisperWasmTranscriber } from './whisper-wasm.js';
export type { WhisperWasmOptions } from './whisper-wasm.js';
export { decodeToMono16k } from './audio.js';
