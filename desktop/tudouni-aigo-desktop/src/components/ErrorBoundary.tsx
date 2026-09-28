import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The last line of defence: one bad message must not blank the window.
 *
 * There was no boundary anywhere in this app, and rendering is not total — a
 * `ui(run_finished)` without `answer` reached `Markdown`, which calls
 * `text.replace`, and one `TypeError` there unmounts the whole tree. The screen
 * goes white and the runtime that caused it is still running, so there is nothing
 * on screen to explain it and no way back except a reload — which, before the
 * reload keys were suppressed, silently started a **new session**.
 *
 * The individual read sites are guarded now (`typeof msg.answer === 'string'`),
 * and that is the real fix. This exists because "there is exactly one unguarded
 * field left" is not a claim anybody can keep true: the protocol tolerates extra
 * and missing fields by design, so any renderer can be handed a shape it did not
 * expect. When that happens the right outcome is a visible error and a working
 * shell, not a white screen.
 *
 * Deliberately a class component: React has no hook equivalent.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Also to the console, where a developer will actually look.
    console.error('the interface failed to render:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash" role="alert">
        <div className="crash-head">The interface failed to render</div>
        {/* The message verbatim: it names the component and the field, which is
            the only thing that makes this actionable. */}
        <pre className="terminal mono crash-detail">{error.stack ?? error.message}</pre>
        <div className="crash-actions">
          {/* A reload restarts the runtime in a fresh session, so this is
              offered as a last resort rather than as the obvious button. */}
          <button type="button" className="btn btn-secondary btn-compact" onClick={() => this.setState({ error: null })}>
            Try rendering again
          </button>
        </div>
      </div>
    );
  }
}
