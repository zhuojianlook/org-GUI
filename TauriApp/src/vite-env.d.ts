/// <reference types="vite/client" />

// Compile-time constant injected by vite.config.ts's `define`. Holds the
// version from package.json so the toolbar can render "v0.2.x" without a
// runtime IPC call.
declare const __APP_VERSION__: string;
