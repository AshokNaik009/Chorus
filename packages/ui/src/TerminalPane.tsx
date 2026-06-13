import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { xtermTheme } from './theme.js';

export interface TerminalPaneHandle {
  /** Write host->terminal output (PTY data) into the screen. */
  write(data: string): void;
  /** Recompute size and report cols/rows via onResize. */
  fit(): void;
  focus(): void;
  /** Access the underlying xterm instance (e.g. to register OSC handlers). */
  getTerminal(): Terminal | null;
}

export interface TerminalPaneProps {
  /** User input typed in the terminal (terminal -> host). */
  onData?: (data: string) => void;
  /** Fires after a fit when the dimensions change (cols/rows). */
  onResize?: (cols: number, rows: number) => void;
  /** Fires once the xterm instance is mounted and ready. */
  onReady?: (term: Terminal) => void;
  className?: string;
}

/**
 * A single xterm.js terminal pane. Framework glue only — it owns the xterm
 * instance, fit + webgl addons, and a ResizeObserver. It knows nothing about
 * websockets, IPC, or sessions; the host wires I/O via props + the imperative
 * handle. See PRD §9 for the canonical xterm<->pty wiring.
 */
export const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(
  function TerminalPane({ onData, onResize, onReady, className }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const lastSizeRef = useRef<{ cols: number; rows: number }>({
      cols: 0,
      rows: 0,
    });

    // Keep callbacks fresh without re-creating the terminal.
    const onDataRef = useRef(onData);
    const onResizeRef = useRef(onResize);
    const onReadyRef = useRef(onReady);
    onDataRef.current = onData;
    onResizeRef.current = onResize;
    onReadyRef.current = onReady;

    const doFit = () => {
      const fit = fitRef.current;
      const term = termRef.current;
      if (!fit || !term) return;
      // Never fit a zero-size container (hidden tab, collapsed pane). The fit
      // addon would clamp to its minimum (~2 cols) and resize the PTY down,
      // wrapping the program's output to a thin strip. Skip until it has size;
      // the ResizeObserver re-fits the moment it's shown again.
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // container not laid out yet
        return;
      }
      const { cols, rows } = term;
      const last = lastSizeRef.current;
      if (cols !== last.cols || rows !== last.rows) {
        lastSizeRef.current = { cols, rows };
        onResizeRef.current?.(cols, rows);
      }
    };

    useImperativeHandle(
      ref,
      () => ({
        write: (data: string) => termRef.current?.write(data),
        fit: doFit,
        focus: () => termRef.current?.focus(),
        getTerminal: () => termRef.current,
      }),
      [],
    );

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const term = new Terminal({
        fontFamily:
          '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
        fontSize: 13,
        lineHeight: 1.25,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
        theme: xtermTheme,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);

      // WebGL is best-effort; fall back to the canvas/DOM renderer.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // no webgl in this environment
      }

      termRef.current = term;
      fitRef.current = fit;

      const dataSub = term.onData((d) => onDataRef.current?.(d));

      const ro = new ResizeObserver(() => doFit());
      ro.observe(container);

      // Initial fit on next frame once layout settles.
      const raf = requestAnimationFrame(() => {
        doFit();
        onReadyRef.current?.(term);
      });

      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        dataSub.dispose();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ width: '100%', height: '100%', overflow: 'hidden' }}
      />
    );
  },
);
