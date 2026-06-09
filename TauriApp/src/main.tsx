import ReactDOM from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles/globals.css";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";

// NOTE: intentionally NOT wrapped in React.StrictMode. Its dev-only double mount
// would fire our side-effecting effects twice — spawning two Emacs PTYs, two
// daemon probes, etc. Production never double-mounts, but we run the dev
// preview, so keep it off.
//
// A top-level ErrorBoundary is the last-resort net: any uncaught render error
// shows a recoverable message with Retry instead of a blank white window.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary label="org-GUI">
    <App />
  </ErrorBoundary>,
);
