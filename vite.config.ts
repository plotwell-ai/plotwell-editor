import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "demo",
  resolve: {
    alias: { "@plotwell/editor": resolve(__dirname, "src/index.ts") },
  },
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "PlotwellEditor",
      fileName: (format) => `index.${format === "es" ? "esm" : format}.js`,
      formats: ["es", "cjs"],
    },
    rollupOptions: {
      external: [
        "prosemirror-commands",
        "prosemirror-history",
        "prosemirror-inputrules",
        "prosemirror-keymap",
        "prosemirror-model",
        "prosemirror-schema-basic",
        "prosemirror-state",
        "prosemirror-view",
      ],
    },
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});
