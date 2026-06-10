/**
 * Compute the argv for launching a session's process through the user's shell.
 *
 * When a command is given (v1: "claude") we run it via a login + interactive
 * shell: the user's profile/rc is sourced (PATH, nvm, etc.) — important when the
 * host's own environment is minimal, e.g. a GUI-launched Electron app — and the
 * shell execs the command directly, so there's no leftover prompt or echoed
 * command in the pane. With no command we get a plain interactive shell (used
 * only by the dev harness "Shell" button).
 *
 * Pure and host-agnostic: the host passes its platform and resolves the cwd.
 */
export function shellLaunchArgs(
  command: string | undefined,
  isWindows: boolean,
): string[] {
  if (!command) return [];
  return isWindows
    ? ['-NoLogo', '-Command', command]
    : ['-l', '-i', '-c', command];
}

/** Claude permission posture. 'default' keeps approval prompts; the others skip them. */
export type AgentPermissionMode = 'default' | 'permissionless' | 'auto-edit';

export interface ClaudeLaunchConfig {
  /** Positional first-turn prompt. Auto-submits, stays interactive. Omit for a blank session. */
  prompt?: string;
  /** Appended to the system prompt (role/context framing). */
  systemPrompt?: string;
  /** e.g. 'opus'. */
  model?: string;
  /** Default 'default'. 'permissionless'|'auto-edit' add --dangerously-skip-permissions. */
  permissionMode?: AgentPermissionMode;
  /** Optional --resume <uuid>. */
  resumeSessionId?: string;
  /**
   * Optional --session-id <uuid> for a NEW conversation: pins the Claude session
   * id at launch so the host can persist it immediately and later `--resume` it
   * exactly — no guessing which transcript belongs to which pane (Epic 11).
   * Ignored when `resumeSessionId` is set (the resumed conversation keeps its id).
   */
  sessionId?: string;
  /**
   * With `resumeSessionId`: add --fork-session, continuing the conversation under
   * a NEW id. Used when the same conversation is already live in another pane
   * (e.g. importing a bundle whose session is still in the current list), so the
   * two panes don't fight over one transcript.
   */
  forkSession?: boolean;
}

/** POSIX single-quote escaping (wrap in '...', escape embedded quotes). */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the `claude …` command string. The prompt is passed as a positional arg
 * after `--` (auto-submits as the first user turn, stays interactive — NOT
 * -p/--print). The host's withClaudeHooks() still injects `--settings` right
 * after `claude`; flags land before `--`, the positional stays after, so the
 * ordering survives. Mirrors agent-orchestrator's getLaunchCommand (MIT).
 */
export function buildClaudeLaunch(config: ClaudeLaunchConfig = {}): string {
  const parts: string[] = ['claude'];
  const mode = config.permissionMode ?? 'default';
  if (mode === 'permissionless' || mode === 'auto-edit') {
    parts.push('--dangerously-skip-permissions');
  }
  if (config.model) parts.push('--model', shellEscape(config.model));
  if (config.resumeSessionId) {
    parts.push('--resume', shellEscape(config.resumeSessionId));
    if (config.forkSession) parts.push('--fork-session');
  } else if (config.sessionId) {
    parts.push('--session-id', shellEscape(config.sessionId));
  }
  if (config.systemPrompt) {
    parts.push('--append-system-prompt', shellEscape(config.systemPrompt));
  }
  if (config.prompt) parts.push('--', shellEscape(config.prompt));
  return parts.join(' ');
}

/**
 * If `command` invokes `claude`, inject `--settings <path>` so the session
 * loads the status hooks (PRD §5.4). The host writes the settings file and
 * passes its path. Other commands are returned unchanged.
 */
export function withClaudeHooks(
  command: string | undefined,
  settingsPath: string,
): string | undefined {
  if (!command) return command;
  const trimmed = command.trimStart();
  if (!/^claude(\s|$)/.test(trimmed)) return command;
  // Single-quote the path for the `-c` shell (assumes no single-quote in path).
  return trimmed.replace(/^claude/, `claude --settings '${settingsPath}'`);
}
