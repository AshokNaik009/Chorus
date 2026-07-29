import type { SessionTraceSource, TraceRequest, TraceSlice } from '@app/core';
import type { PaneApi } from '../../shared/ipc.js';

/**
 * Renderer-side `SessionTraceSource` for Electron: the SESSION TRACE panel's
 * window onto the focused pane's transcript. Main does the file work; this only
 * marshals over `paneApi`. Sibling of `ElectronSessionCatalog`.
 */
export class ElectronTraceSource implements SessionTraceSource {
  constructor(private readonly api: PaneApi) {}

  readTrace(req: TraceRequest): Promise<TraceSlice | null> {
    return this.api.readTrace(req);
  }
}
