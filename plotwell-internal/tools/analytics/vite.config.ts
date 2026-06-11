import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import federation from "@originjs/vite-plugin-federation";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, "../.."), "VITE_");
  const supabaseUrl = env.VITE_SUPABASE_URL || "https://ueqiwkticcbicfqkbuak.supabase.co";
  const supabaseKey = env.VITE_SUPABASE_SERVICE_ROLE_KEY || "";

  return {
    envDir: path.resolve(__dirname, "../.."),
    plugins: [
      react(),
      federation({
        name: "analytics",
        filename: "remoteEntry.js",
        exposes: {
          "./App": "./src/App.tsx",
        },
        shared: ["react", "react-dom"],
      }),
    ],
    server: {
      port: 5187,
      proxy: {
        "/stripe-api": {
          target: "https://api.stripe.com",
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/stripe-api/, ""),
        },
        "/google-ads-api": {
          target: "https://googleads.googleapis.com",
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/google-ads-api/, ""),
        },
        "/supabase-api": {
          target: supabaseUrl,
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/supabase-api/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.setHeader("Authorization", `Bearer ${supabaseKey}`);
              proxyReq.setHeader("apikey", supabaseKey);
              proxyReq.removeHeader("origin");
              proxyReq.removeHeader("referer");
              proxyReq.removeHeader("sec-fetch-mode");
              proxyReq.removeHeader("sec-fetch-site");
              proxyReq.removeHeader("sec-fetch-dest");
              proxyReq.removeHeader("sec-ch-ua");
              proxyReq.removeHeader("sec-ch-ua-mobile");
              proxyReq.removeHeader("sec-ch-ua-platform");
              proxyReq.setHeader("User-Agent", "node");
            });
          },
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
