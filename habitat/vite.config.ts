import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendUrl = env.HABITAT_SERVER_URL ?? `http://localhost:${env.HABITAT_SERVER_PORT ?? "8787"}`;

  return {
    root: "web",
    server: {
      port: Number(env.HABITAT_WEB_PORT ?? "5173"),
      proxy: {
      "/state": backendUrl,
      "/commands": backendUrl,
      "/kepler": backendUrl,
      "/health": backendUrl,
      "/auth": backendUrl,
      "/admin": backendUrl,
      },
    },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
