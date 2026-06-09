import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.resolve(__dirname),
  clearScreen: false,
  // Inject the package version as a compile-time constant so the toolbar
  // can show "v0.2.x" without an async Tauri call.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // The app only ever runs in a modern WKWebView / WebView2, so target a
    // recent baseline — less transpilation, smaller + faster-to-parse output.
    target: "es2022",
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Split the rarely-changing framework code into its own chunks so the
        // main app chunk stays smaller and these cache across app updates.
        // xterm + the gcal panel are split separately via React.lazy.
        manualChunks: {
          "vendor-flow": ["@xyflow/react"],
        },
      },
    },
  },
  server: {
    port: parseInt(process.env.PORT || "1420", 10),
    strictPort: false,
    host: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
