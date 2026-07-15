import { serve } from "bun";
import "./load-env";
import { createApp } from "./server/routes";

export { createApp } from "./server/routes";

export async function startServer(port: number): Promise<void> {
  const app = createApp();
  const host = process.env.HOST ?? "0.0.0.0";
  serve({
    hostname: host,
    port,
    fetch: app.fetch,
  });
  console.log(`Habitat backend listening on http://${host}:${port}`);
}

if (import.meta.main) {
  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  await startServer(Number.isFinite(port) ? port : 8787);
}
