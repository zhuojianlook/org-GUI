import React from "react";
import ReactDOM from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles/globals.css";
import App from "./App";

// NOTE: intentionally NOT wrapped in React.StrictMode — its dev-only double
// mount breaks @replit/codemirror-vim (keys stop responding). Production builds
// don't double-mount, but we run the dev preview, so keep it off.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
