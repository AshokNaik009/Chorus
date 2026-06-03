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
