Task 4 completed.

What changed:

- Added focused domain modules for inventory, modules, power, and construction rules.
- Added `src/domain/commands.ts` with backend command handlers for `construct`, `module/create`, `inventory/set`, `module/set-status`, and `tick`.
- Wired `src/server/routes.ts` to expose the new `/commands/*` endpoints.
- Updated `src/index.ts` to reuse the shared inventory rules from the new domain module.
- Added the requested inventory rule test at `test/domain-commands.test.ts`.

Verification:

- `bun test test/domain-commands.test.ts`
- `bun test`

Both passed.

Fix update:

- Restored the backend tick command to match the prior CLI simulation loop: per-module power-consumption counters, solar charging, battery drain/charge accounting, and construction advancement now run in the backend domain handler again.
- Removed the backend-only duplicate-blueprint guard from `construct`, so repeated jobs can start as long as a free matching facility exists, consistent with the previous CLI behavior.

Verification run for this fix:

- `bun test test/domain-commands.test.ts` — passed.
- `bun test` — passed.
