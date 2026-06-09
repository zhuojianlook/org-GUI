import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Catches render/runtime errors in its subtree (including a failed lazy-chunk
 * load) so one broken panel can't white-screen the whole app. Shows a compact,
 * themed message with a Retry that remounts the children. `label` names the
 * area for the message; `onReset` lets the parent also clear related state.
 */
interface Props {
  children: ReactNode;
  label?: string;
  onReset?: () => void;
}
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to the console for diagnostics; the UI stays usable.
    console.error(`[org-GUI] ${this.props.label ?? "panel"} crashed:`, error, info);
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            color: "var(--c-text)",
            fontSize: 12.5,
            maxWidth: 360,
          }}
        >
          <div style={{ fontWeight: 700, color: "#ff5f56" }}>
            {this.props.label ?? "This panel"} hit an error
          </div>
          <div style={{ color: "var(--c-text-dim)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {String(this.state.error.message || this.state.error)}
          </div>
          <button
            onClick={this.reset}
            style={{
              alignSelf: "flex-start",
              padding: "4px 12px",
              borderRadius: 6,
              border: "1px solid var(--c-border)",
              background: "var(--c-surface2)",
              color: "var(--c-text)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            ↻ Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
