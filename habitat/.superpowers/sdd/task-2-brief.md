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

