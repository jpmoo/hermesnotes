import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Built to static files, and served by the shell — there is no web server here.
 *
 * The brief asks whether the canvas has to be one. It does not: `scheme.py`
 * already serves `/ui/` from disk over `talaria-app://`, which is how every
 * other panel is delivered, and a bundle is just more files in that directory.
 * No port is opened, nothing listens, and the page reaches the daemon through
 * the same Unix socket the rest of the shell uses.
 *
 * `base: "./"` because of that: the bundle is loaded from
 * `talaria-app://daemon/ui/canvas/index.html` and an absolute `/assets/…` would
 * be asked of the daemon rather than of the file server beside it.
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    /*
     * The pieces of Hermes' app the canvas expects to be inside.
     *
     * Aliased rather than edited into the component: `CanvasView.tsx` is a
     * fork, and every line changed in it is a line to merge by hand the next
     * time Hermes' canvas learns something. The shims say what Talaria answers
     * instead — no router, no shared package, and a block card that is a card
     * rather than an editor.
     */
    alias: {
      "react-router-dom": "/src/shims/router.tsx",
      "@hermes/shared": "/src/shims/shared.ts",
    },
  },
  build: {
    outDir: "../shell/ui/canvas",
    emptyOutDir: true,
    // One file each, named plainly. The shell serves these by path and a
    // content hash in the name buys nothing when there is no cache to bust.
    rollupOptions: {
      output: {
        entryFileNames: "canvas.js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
