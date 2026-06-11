import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import federation from "@originjs/vite-plugin-federation";
import path from "path";

export default defineConfig(() => {
  return {
    envDir: path.resolve(__dirname, "../.."),
    plugins: [
      react(),
      federation({
        name: "media",
        filename: "remoteEntry.js",
        exposes: {
          "./App": "./src/App.tsx",
        },
        shared: ["react", "react-dom"],
      }),
    ],
    server: {
      proxy: {
        "/replicate-api": {
          target: "https://api.replicate.com",
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/replicate-api/, ""),
        },
      },
    },
    build: {
      modulePreload: false,
      target: "esnext",
      minify: false,
      cssCodeSplit: false,
    },
  };
});
