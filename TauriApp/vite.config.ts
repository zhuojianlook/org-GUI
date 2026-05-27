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
  server: {
    port: parseInt(process.env.PORT || "1420", 10),
    strictPort: false,
    host: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
