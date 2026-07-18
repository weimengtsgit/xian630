import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1400,
  },
  server: {
    host: "127.0.0.1",
    port: 5179,
    proxy: {
      "/api/seasats": "http://127.0.0.1:5180",
    },
  },
});
