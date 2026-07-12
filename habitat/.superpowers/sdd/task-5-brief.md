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
