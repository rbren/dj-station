// Render-error containment. One boundary wraps the whole app (so a crash
// shows a message instead of a blank window) and one wraps each module panel
// (so a single misbehaving module — or bad telemetry for it — doesn't take
// the rest of the rack with it).

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorMessage, reportError } from '../errors';

interface Props {
  /** Shown in the fallback and in the error banner. */
  context: string;
  children: ReactNode;
  /** Overrides the default fallback card. */
  fallback?(message: string, retry: () => void): ReactNode;
}

interface State {
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: errorMessage(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportError(this.props.context, error, info.componentStack);
  }

  private retry = () => this.setState({ message: null });

  render() {
    const { message } = this.state;
    if (message === null) return this.props.children;
    if (this.props.fallback) return this.props.fallback(message, this.retry);
    return (
      <div className="error-card" data-testid={`error-boundary-${this.props.context}`}>
        <strong>{this.props.context} failed to render</strong>
        <code className="error-card-message">{message}</code>
        <button onClick={this.retry}>Retry</button>
      </div>
    );
  }
}
