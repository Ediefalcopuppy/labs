# Full Proxy API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Habitat CLI to a REST-backed full proxy architecture where the backend owns SQLite, Kepler integration, state mutation, and simulation.

**Architecture:** The backend becomes the single source of truth for all habitat behavior and persistence, while the CLI becomes a thin command wrapper that only parses arguments, calls REST endpoints, and prints responses. We will preserve command names and user-facing behavior during the migration, but shift implementation detail out of `src/index.ts` into focused backend modules with clear responsibilities.

**Tech Stack:** TypeScript, Bun, Hono, SQLite, existing Kepler HTTP integration, existing CLI command surface.

## Global Constraints

- Prefer TypeScript for new JavaScript or TypeScript projects.
- Prefer Bun over npm when the project supports it.
- Keep entrypoint files focused on orchestration, not implementation details.
- Put command wiring, route setup, or app bootstrapping in the entrypoint.
- Move domain logic into focused modules with clear names.
- Move external service calls into dedicated integration or client modules.
- Move file, database, or persistence logic into dedicated storage or state modules.
- Keep shared types in explicit type files when they are used across modules.
- Prefer small, named functions over large inline handlers.
- Avoid letting any single file become a catch-all for unrelated behavior.
- During development, start the backend explicitly with `bun run server`.

---

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

### Task 2: Move local habitat state into backend storage

**Files:**
- Create: `src/state/types.ts`
- Create: `src/state/storage.ts`
- Create: `src/state/service.ts`
- Modify: `src/server/routes.ts`
- Modify: `src/index.ts`
- Modify: `src/storage.ts`

**Interfaces:**
- Consumes: habitat state shape, SQLite access, state service methods
- Produces: `getState()`, `saveState()`, `resetState()`, and HTTP handlers for state reads/writes

- [ ] **Step 1: Write the failing test**

Create `test/state-service.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createStateService } from "../src/state/service";

describe("state service", () => {
  test("starts with empty normalized state", async () => {
    const service = createStateService({ storagePath: ":memory:" });
    const state = await service.getState();
    expect(state.modules).toEqual([]);
    expect(state.inventory).toEqual({});
    expect(state.constructionJobs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/state-service.test.ts`
Expected: fail because `src/state/service` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create the shared habitat state type file, move SQLite read/write logic into `src/state/storage.ts`, and wrap it in a state service that normalizes empty state and persists through SQLite.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/state-service.test.ts`
Expected: pass and return normalized empty state.

- [ ] **Step 5: Commit**

```bash
git add src/state/types.ts src/state/storage.ts src/state/service.ts test/state-service.test.ts src/server/routes.ts src/index.ts src/storage.ts
git commit -m "feat: move habitat state into backend"
```

### Task 3: Move Kepler integration behind backend services

**Files:**
- Create: `src/kepler/client.ts`
- Create: `src/kepler/service.ts`
- Modify: `src/server/routes.ts`
- Modify: `src/kepler-client.ts`

**Interfaces:**
- Consumes: Kepler HTTP endpoints, auth token, state service
- Produces: backend methods for registration, catalog refresh, and solar data fetches

- [ ] **Step 1: Write the failing test**

Create `test/kepler-service.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { normalizeKeplerCatalog } from "../src/kepler/service";

describe("kepler service", () => {
  test("normalizes blueprint catalog entries", () => {
    const catalog = normalizeKeplerCatalog([
      { id: "bp-1", name: "Starter", buildable: true }
    ]);
    expect(catalog[0].id).toBe("bp-1");
    expect(catalog[0].name).toBe("Starter");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/kepler-service.test.ts`
Expected: fail because `src/kepler/service` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Move the current Kepler fetch/normalize code into a backend client plus service layer, preserving the same response normalization but making the backend the only place that talks to `planet.turingguild.com`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/kepler-service.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/kepler/client.ts src/kepler/service.ts test/kepler-service.test.ts src/server/routes.ts src/kepler-client.ts
git commit -m "feat: move kepler access behind backend"
```

### Task 4: Move construction, inventory, module, and power rules into backend commands

**Files:**
- Create: `src/domain/construction.ts`
- Create: `src/domain/modules.ts`
- Create: `src/domain/inventory.ts`
- Create: `src/domain/power.ts`
- Create: `src/domain/commands.ts`
- Modify: `src/server/routes.ts`
- Modify: `src/construction.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: state service, kepler service, shared domain helpers
- Produces: backend command handlers for `construct`, `module/create`, `inventory/set`, `module/set-status`, and `tick`

- [ ] **Step 1: Write the failing test**

Create `test/domain-commands.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { canSpendInventory } from "../src/domain/inventory";

describe("inventory rules", () => {
  test("detects when materials are available", () => {
    expect(canSpendInventory({ steel: 2 }, { steel: 1 })).toBe(true);
    expect(canSpendInventory({ steel: 1 }, { steel: 2 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/domain-commands.test.ts`
Expected: fail because `src/domain/inventory` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Move the reusable domain helpers out of the CLI entrypoint into focused domain modules, then wire backend command handlers to call them and persist the resulting state.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/domain-commands.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/construction.ts src/domain/modules.ts src/domain/inventory.ts src/domain/power.ts src/domain/commands.ts test/domain-commands.test.ts src/server/routes.ts src/construction.ts src/index.ts
git commit -m "feat: move habitat rules into backend commands"
```

### Task 5: Convert the CLI to a thin REST client and keep the existing command surface

**Files:**
- Modify: `src/index.ts`
- Create: `src/client.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: backend endpoints, CLI argument parsing, backend base URL config
- Produces: thin command handlers that delegate to REST

- [ ] **Step 1: Write the failing test**

Create `test/client.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildBackendUrl } from "../src/client";

describe("client config", () => {
  test("uses a default backend url", () => {
    expect(buildBackendUrl()).toContain("http://");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/client.test.ts`
Expected: fail because `src/client` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add a small REST client wrapper, replace direct local state and Kepler calls in `src/index.ts` with backend requests, and keep the existing command names and output formatting intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/client.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts src/index.ts package.json test/client.test.ts
git commit -m "feat: make cli a thin backend client"
```

## Spec Coverage Check

- Backend owns SQLite: Task 2
- Backend owns all Kepler calls: Task 3
- Backend owns construction, inventory, module, and power logic: Task 4
- CLI becomes thin wrapper: Task 5
- Local development uses `bun run server`: Task 1 and the global constraints

## Placeholder Scan

No placeholders remain. Every task names concrete files, behavior, and a test checkpoint.

## Type Consistency Check

The plan uses the same backend split throughout:

- `createApp()` and `startServer()` in Task 1
- `createStateService()` in Task 2
- `normalizeKeplerCatalog()` and backend Kepler service methods in Task 3
- domain helpers and backend command handlers in Task 4
- `buildBackendUrl()` and the CLI REST wrapper in Task 5

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-full-proxy-api.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
