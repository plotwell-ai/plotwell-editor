import { defineConfig } from "vite";
import { resolve } from "path";

// Build config for the standalone demo page (editor.plotwell.co)
// Bundles everything including ProseMirror into a single deployable site.
export default defineConfig({
  root: "demo",
  resolve: {
    alias: { "@plotwell/editor": resolve(__dirname, "src/index.ts") },
  },
  build: {
    outDir: resolve(__dirname, "demo-dist"),
    emptyOutDir: true,
  },
});
