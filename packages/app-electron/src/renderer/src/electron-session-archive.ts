import {
  resumeArgs,
  type ContextHealth,
  type ConversationRef,
  type ImportConversationsResult,
  type SessionArchive,
} from '@app/core';
import type { PaneApi } from '../../shared/ipc.js';

/**
 * Renderer-side `SessionArchive` for Electron (PRD Epic 11, Layer 2). All the
 * `~/.claude` work happens in the main process; this adapter marshals over
 * `paneApi`. `resumeArgs` is pure core logic. The web harness injects nothing, so
 * the UI only offers Layer-1 (workspace) export/import there (US-11.6).
 */
export class ElectronSessionArchive implements SessionArchive {
  constructor(private readonly api: PaneApi) {}

  captureSessionId(paneSessionId: string, cwd: string): Promise<string | null> {
    return this.api.captureSessionId(paneSessionId, cwd);
  }

  hasConversation(claudeSessionId: string, cwd: string): Promise<boolean> {
    return this.api.hasConversation(claudeSessionId, cwd);
  }

  exportConversations(
    items: { sessionId: string; cwd: string }[],
  ): Promise<ConversationRef[]> {
    return this.api.exportConversations(items);
  }

  /**
   * Apply the caller's path remap in the renderer (functions can't cross IPC),
   * then hand the already-remapped refs to main for writing under each target
   * machine's project slug.
   */
  importConversations(
    refs: ConversationRef[],
    remap: (origPath: string) => string,
  ): Promise<ImportConversationsResult> {
    const mapped = refs.map((r) => ({
      ...r,
      originalProjectPath: remap(r.originalProjectPath),
    }));
    return this.api.importConversations(mapped);
  }

  resumeArgs(claudeSessionId: string): string[] {
    return resumeArgs(claudeSessionId);
  }

  readContextHealth(
    claudeSessionId: string,
    cwd: string,
  ): Promise<ContextHealth | null> {
    return this.api.readContextHealth(claudeSessionId, cwd);
  }
}
