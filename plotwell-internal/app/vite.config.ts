import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, ".."), "VITE_");
  const supabaseUrl = env.VITE_SUPABASE_URL || "https://ueqiwkticcbicfqkbuak.supabase.co";
  const supabaseKey = env.VITE_SUPABASE_SERVICE_ROLE_KEY || "";

  return {
    envDir: path.resolve(__dirname, ".."),
    plugins: [react()],
    resolve: {
      alias: {
        "@tools/blog": path.resolve(__dirname, "../tools/blog/src"),
        "@tools/social": path.resolve(__dirname, "../tools/social/src"),
        "@tools/seo": path.resolve(__dirname, "../tools/seo/src"),
        "@tools/sem": path.resolve(__dirname, "../tools/sem/src"),
        "@tools/email": path.resolve(__dirname, "../tools/email/src"),
        "@tools/accounting": path.resolve(__dirname, "../tools/accounting/src"),
        "@tools/analytics": path.resolve(__dirname, "../tools/analytics/src"),
        "@tools/calendar": path.resolve(__dirname, "../tools/calendar/src"),
        "@tools/accountability": path.resolve(__dirname, "../tools/accountability/src"),
        "@tools/history": path.resolve(__dirname, "../tools/history/src"),
        "@tools/media": path.resolve(__dirname, "../tools/media/src"),
        "@tools/focus": path.resolve(__dirname, "../tools/focus/src"),
      },
    },
    server: {
      port: 5180,
      proxy: {
        "/replicate-api": {
          target: "https://api.replicate.com",
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/replicate-api/, ""),
        },
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
              // Strip all browser-identifying headers
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
  };
});
