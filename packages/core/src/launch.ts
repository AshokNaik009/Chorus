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
