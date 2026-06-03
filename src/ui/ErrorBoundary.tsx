/**
 * ErrorBoundary — wraps a view-mode subtree so a throw inside (e.g. TableRoot
 * dereferencing a missing card / null lane) doesn't wipe the entire view.
 *
 * Renders a calm fallback with a Retry affordance. The board view mode tab
 * stays clickable so the user can switch back without re-opening the file.
 *
 * Table mode used to crash the whole React tree because
 * nothing caught the throw. This boundary is composed around `<TableRoot>`,
 * `<ListRoot>`, and (defensively) `<BoardView>` in `BoardRoot`.
 */
import * as React from 'react';

export interface ErrorBoundaryProps {
  /** Human label of the surface ("Table view", "List view") used in the fallback copy. */
  label?: string;
  /** Optional escape hatch — e.g. "Open as text" in `KanbanView`. */
  onOpenAsText?: () => void;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Console-only — Obsidian's notice surface is owned by the view layer.
    // We never want to crash twice trying to report a crash.
    //
    // emit a structured record so we can diagnose a recurrence of the
    // React #185 crash on complex board drag from a single transcript
    // without a debugger. The label distinguishes which boundary fired
    // (Board / Table / List / detail panel). `componentStack` is the
    // React-owned trail of suspended frames; `error.stack` is the JS
    // engine trail. Both are useful and not always overlapping.
    console.error('[kanban-pro] view crash:', {
      label: this.props.label ?? 'unknown',
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
      componentStack: info.componentStack,
      at: new Date().toISOString(),
    });
    // Surface a CustomEvent so an integration test (or future telemetry
    // sink) can latch onto crashes without depending on the console.
    try {
      window.dispatchEvent(
        new CustomEvent('kanban-pro:error-boundary-caught', {
          detail: {
            label: this.props.label,
            name: error?.name,
            message: error?.message,
          },
        }),
      );
    } catch {
      // No `window` in some test environments — best-effort.
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const label = this.props.label ?? 'This view';
    return (
      <div className="kp-error-boundary" role="alert" aria-live="assertive">
        <div className="kp-error-boundary__head">
          <h2 className="kp-error-boundary__title">{label} crashed</h2>
        </div>
        <p className="kp-error-boundary__detail">
          Something went wrong rendering this view. Switch to another view
          mode, or hit retry to try again.
        </p>
        <pre className="kp-error-boundary__pre">{String(error.message ?? error)}</pre>
        <div className="kp-error-boundary__actions">
          <button
            type="button"
            className="kp-control"
            onClick={this.handleRetry}
            aria-label="Retry rendering"
          >
            Retry
          </button>
          {this.props.onOpenAsText ? (
            <button
              type="button"
              className="kp-control"
              onClick={this.props.onOpenAsText}
              aria-label="Open as text"
            >
              Open as text
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
