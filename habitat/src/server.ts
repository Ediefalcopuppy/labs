import { serve } from "bun";
import { createApp } from "./server/routes";

export { createApp } from "./server/routes";

export async function startServer(port: number): Promise<void> {
  const app = createApp();
  serve({
    port,
    fetch: app.fetch,
  });
}

if (import.meta.main) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  await startServer(Number.isFinite(port) ? port : 3000);
}
