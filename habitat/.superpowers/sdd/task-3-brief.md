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

