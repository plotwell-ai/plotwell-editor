import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import federation from "@originjs/vite-plugin-federation";
import path from "path";

export default defineConfig({
  envDir: path.resolve(__dirname, "../.."),
  plugins: [
    react(),
    federation({
      name: "accounting",
      filename: "remoteEntry.js",
      exposes: {
        "./App": "./src/App.tsx",
      },
      shared: ["react", "react-dom"],
    }),
  ],
  server: {
    port: 5186,
    proxy: {
      "/stripe-api": {
        target: "https://api.stripe.com",
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/stripe-api/, ""),
      },
      "/replicate-api": {
        target: "https://api.replicate.com",
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/replicate-api/, ""),
      },
    },
  },
  build: {
    modulePreload: false,
    target: "esnext",
    minify: false,
    cssCodeSplit: false,
  },
});
