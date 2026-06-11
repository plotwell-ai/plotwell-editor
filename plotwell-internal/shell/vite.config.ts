import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import federation from "@originjs/vite-plugin-federation";

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: "shell",
      remotes: {
        media:          "http://localhost:5191/assets/remoteEntry.js",
        blog:           "http://localhost:5181/assets/remoteEntry.js",
        social:         "http://localhost:5182/assets/remoteEntry.js",
        email:          "http://localhost:5185/assets/remoteEntry.js",
        accountability: "http://localhost:5189/assets/remoteEntry.js",
        focus:          "http://localhost:5192/assets/remoteEntry.js",
      },
      shared: ["react", "react-dom"],
    }),
  ],
  server: {
    proxy: {
      "/replicate-api": {
        target: "https://api.replicate.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/replicate-api/, ""),
      },
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
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
