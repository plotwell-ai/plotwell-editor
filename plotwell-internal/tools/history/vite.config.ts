import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import federation from "@originjs/vite-plugin-federation";
import path from "path";

export default defineConfig({
  envDir: path.resolve(__dirname, "../.."),
  plugins: [
    react(),
    federation({ name: "history", filename: "remoteEntry.js", exposes: { "./App": "./src/App.tsx" }, shared: ["react", "react-dom"] }),
  ],
  build: { modulePreload: false, target: "esnext", minify: false, cssCodeSplit: false },
});
