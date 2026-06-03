/// <reference types="vite/client" />

// Compile-time constant injected by vite.config.ts's `define`. Holds the
// version from package.json so the toolbar can render "v0.2.x" without a
// runtime IPC call.
declare const __APP_VERSION__: string;

// Build-time Google OAuth client (see src/config/google.ts). Supplied via
// VITE_-prefixed env vars — GitHub Actions secrets in CI, .env.local locally.
interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_GOOGLE_CLIENT_SECRET?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
