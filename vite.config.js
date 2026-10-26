import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "0.0.0.0", port: 5180, strictPort: true },
  optimizeDeps: { exclude: ["jolt-physics"] },
});
