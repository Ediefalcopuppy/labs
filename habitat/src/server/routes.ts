import { Hono } from "hono";
import { registerHealthRoute } from "./health";

export function createApp(): Hono {
  const app = new Hono();
  registerHealthRoute(app);
  return app;
}
