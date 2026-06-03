/**
 * @app/ui — React + xterm.js presentation layer.
 *
 * Depends only on @app/core interfaces; never imports a host package or
 * node-pty directly (PRD §11).
 */
export { TerminalPane } from './TerminalPane.js';
export type { TerminalPaneHandle, TerminalPaneProps } from './TerminalPane.js';
export { darkTheme, xtermTheme } from './theme.js';

// Re-exported so hosts can type their wiring against the same status union.
export type { SessionStatus } from '@app/core';
