import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: { assetsDir: "workspace-assets" },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3100",
      "/edit": "http://127.0.0.1:3100",
      "/_app": "http://127.0.0.1:3100",
      "/service-worker.js": "http://127.0.0.1:3100",
    },
  },
});
