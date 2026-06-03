import type { ITheme } from '@xterm/xterm';

/** The single dark theme shipped in v1 (PRD §3: one dark theme only). */
export const darkTheme = {
  bg: '#0e1116',
  bgElevated: '#161b22',
  border: '#272d36',
  fg: '#c9d1d9',
  fgMuted: '#7d8590',
  accent: '#58a6ff',
  // status colors
  spawning: '#7d8590',
  running: '#3fb950',
  waiting: '#d29922',
  idle: '#58a6ff',
  exited: '#6e7681',
} as const;

/** xterm.js terminal theme matching the app dark theme. */
export const xtermTheme: ITheme = {
  background: darkTheme.bg,
  foreground: darkTheme.fg,
  cursor: darkTheme.accent,
  cursorAccent: darkTheme.bg,
  selectionBackground: '#2d4f76',
  black: '#0e1116',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};
