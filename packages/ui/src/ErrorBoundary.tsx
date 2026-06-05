import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Bump this (e.g. the active workspace id) to auto-reset after a switch. */
  resetKey?: string;
}
interface State {
  error: Error | null;
  info: string;
}

/**
 * Catches render crashes in its subtree (e.g. a pane/terminal blowing up on a
 * workspace switch) so one failure can't white-screen the whole app. Shows the
 * message + stack inline with a Reset, and auto-recovers when `resetKey` changes.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[Chorus] render error:', error, info.componentStack);
    this.setState({ info: info.componentStack ?? '' });
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, info: '' });
    }
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          height: '100%',
          overflow: 'auto',
          padding: 24,
          background: 'var(--bg)',
          color: 'var(--fg)',
          fontFamily: 'ui-monospace, Menlo, monospace',
        }}
      >
        <div style={{ color: 'var(--status-waiting)', fontWeight: 700, marginBottom: 8 }}>
          Something in this view crashed.
        </div>
        <div style={{ marginBottom: 12, color: 'var(--fg-muted)', fontSize: 12 }}>
          The rest of Chorus still works — switch workspaces or Reset. Please copy
          this for the bug report:
        </div>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            fontSize: 12,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            color: 'var(--status-waiting)',
          }}
        >
          {error.message}
          {'\n'}
          {info}
        </pre>
        <button
          onClick={() => this.setState({ error: null, info: '' })}
          style={{
            marginTop: 12,
            background: 'var(--accent)',
            color: '#0e1116',
            border: 'none',
            borderRadius: 6,
            padding: '7px 14px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Reset view
        </button>
      </div>
    );
  }
}
