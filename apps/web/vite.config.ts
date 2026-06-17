import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/auth": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
      "/public": "http://127.0.0.1:3000",
      "/v1": "http://127.0.0.1:3000"
    }
  }
});
