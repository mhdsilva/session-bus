import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.SESSION_BUS_HUB_URL ?? "http://127.0.0.1:7345",
        changeOrigin: false,
        ws: true,
      },
    },
  },
  test: { environment: "jsdom" },
});
