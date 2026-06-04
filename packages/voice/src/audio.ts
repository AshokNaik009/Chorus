/**
 * Decode a recorded audio Blob to the mono 16 kHz Float32 PCM that Whisper
 * expects. Pure-Web-Audio, so it runs in both renderers (no native deps). The
 * captured audio never leaves the device — decode happens locally.
 */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuf = await blob.arrayBuffer();

  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const ctx = new Ctor();
  let decoded: AudioBuffer;
  try {
    // slice(0) → decode a copy; decodeAudioData may detach the source buffer.
    decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    void ctx.close();
  }

  const targetRate = 16000;
  if (decoded.sampleRate === targetRate && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0).slice();
  }

  // Resample (and downmix) to 16 kHz mono via an offline render.
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}
