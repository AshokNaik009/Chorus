import type { ITheme } from '@xterm/xterm';

/**
 * The single dark theme shipped in v1 (PRD §3: one dark theme only).
 * herdr design system — Catppuccin Mocha.
 */
export const darkTheme = {
  bg: '#1e1e2e', // base
  bgElevated: '#181825', // mantle
  bgDeep: '#11111b', // crust (terminal)
  border: 'rgba(205,214,244,0.10)', // line
  fg: '#cdd6f4', // text
  fgMuted: '#7f849c', // faint
  accent: '#cba6f7', // mauve
  // status colors (Chorus names mapped to herdr signal palette)
  spawning: '#6c7086', // unknown
  running: '#f9e2af', // working
  waiting: '#f38ba8', // blocked
  idle: '#a6e3a1', // idle
  exited: '#6c7086', // unknown
} as const;

/** xterm.js terminal theme — Catppuccin Mocha, on the crust (deepest) surface. */
export const xtermTheme: ITheme = {
  background: '#11111b', // crust
  foreground: '#cdd6f4', // text
  cursor: '#cba6f7', // mauve
  cursorAccent: '#11111b',
  selectionBackground: '#45475a', // surface1
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#cba6f7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};
