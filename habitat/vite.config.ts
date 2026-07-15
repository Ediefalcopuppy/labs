import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  server: { port: 5173, proxy: { "/": "http://localhost:3000" } },
  build: { outDir: "dist", emptyOutDir: true },
});
