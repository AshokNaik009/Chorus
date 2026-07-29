import type { SessionTraceSource, TraceRequest, TraceSlice } from '@app/core';

/**
 * Browser-side `SessionTraceSource`: fetches transcript bytes from the dev
 * server's `/trace` route. Counterpart to Electron's `ElectronTraceSource` —
 * the parsing that turns those bytes into turns is the same core code on both
 * hosts, only the transport differs.
 *
 * Any failure (server down, no transcript yet) resolves to null so the panel's
 * poll can never throw; it just shows nothing until bytes exist.
 */
export class WebTraceSource implements SessionTraceSource {
  constructor(private readonly baseUrl: string) {}

  async readTrace(req: TraceRequest): Promise<TraceSlice | null> {
    const url = new URL('/trace', this.baseUrl);
    url.searchParams.set('id', req.claudeSessionId);
    url.searchParams.set('cwd', req.cwd);
    if (req.from !== undefined) url.searchParams.set('from', String(req.from));
    if (req.maxBytes !== undefined) url.searchParams.set('max', String(req.maxBytes));
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      // 204 is "no transcript yet" — the normal case for a fresh pane.
      if (res.status === 204 || !res.ok) return null;
      return (await res.json()) as TraceSlice;
    } catch {
      return null;
    }
  }
}
