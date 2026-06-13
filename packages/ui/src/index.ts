/**
 * @app/ui — React + xterm.js presentation layer.
 *
 * Depends only on @app/core interfaces; never imports a host package or
 * node-pty directly (PRD §11).
 */
export { App } from './App.js';
export type { AppProps } from './App.js';
export { TerminalPane } from './TerminalPane.js';
export type { TerminalPaneHandle, TerminalPaneProps } from './TerminalPane.js';
export { SessionTerminal } from './SessionTerminal.js';
export { LayoutView } from './LayoutView.js';
export { TabbedView } from './TabbedView.js';
export type { TabbedViewProps } from './TabbedView.js';
export { Sidebar } from './Sidebar.js';
export { PaneLauncher } from './PaneLauncher.js';
export { StatusBadge } from './StatusBadge.js';
export { MemoryControls } from './MemoryControls.js';
export type { MemoryControlsProps, ExportPayload } from './MemoryControls.js';
export { downloadTextFile, pickTextFile } from './file-io.js';
export {
  useVoiceCapture,
  useVoiceHotkey,
  parseHotkey,
  VoiceMicButton,
  RecordingIndicator,
  VoiceSettingsButton,
} from './Voice.js';
export type { VoiceStatus } from './Voice.js';
export { HelpButton } from './Tutorial.js';
export { ErrorBoundary } from './ErrorBoundary.js';
export { SwarmPanel } from './SwarmPanel.js';
export type { SwarmPanelProps } from './SwarmPanel.js';
export { darkTheme, xtermTheme } from './theme.js';

// Re-exported so hosts can type their wiring against the same status union.
export type { SessionStatus } from '@app/core';
