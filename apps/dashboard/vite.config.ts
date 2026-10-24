import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const gateway = process.env.GATEWAY_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { "/api": { target: gateway, changeOrigin: false }, "/mcp": { target: gateway, changeOrigin: false } } },
  build: { sourcemap: false, target: "es2022" },
});
