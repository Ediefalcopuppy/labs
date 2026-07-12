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

