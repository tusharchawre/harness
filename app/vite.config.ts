import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port 1420 is what tauri.conf.json's devUrl points at.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
});
