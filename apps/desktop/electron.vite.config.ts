import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import pkg from "./package.json";

// Main and preload are emitted as CommonJS (the package is not "type": "module"),
// which the sandboxed preload requires. The renderer is bundled locally and
// loaded with loadFile in production; it never loads remote code.
export default defineConfig({
  main: {
    // Also correct when Electron is started on the bundle file directly.
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    // Brand images are imported with ?asset and copied into out/; don't leave them as a runtime require.
    build: { externalizeDeps: { exclude: ["@agentstudio/brand"] } },
  },
  preload: {},
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    // Dev server stays on loopback like the rest of the local stack.
    server: { host: "127.0.0.1" },
    build: {
      rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
    },
  },
});
