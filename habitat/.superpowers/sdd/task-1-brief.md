### Task 1: Add the backend app shell and health endpoint

**Files:**
- Create: `src/server.ts`
- Create: `src/server/routes.ts`
- Create: `src/server/health.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `Bun.serve`, `Hono`
- Produces: `createApp(): Hono`, `startServer(port: number): Promise<void>`, and a `bun run server` script

- [ ] **Step 1: Write the failing test**

Create `test/server.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server";

describe("backend health", () => {
  test("GET /health returns ok", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/server.test.ts`
Expected: fail because `src/server` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add a small Hono app that mounts `GET /health` and returns `"ok"`, then export a `createApp()` function and a `startServer()` helper that listens with Bun.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/server.test.ts`
Expected: pass with `200` and body `ok`.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/server/routes.ts src/server/health.ts test/server.test.ts package.json
git commit -m "feat: add backend server shell"
```

