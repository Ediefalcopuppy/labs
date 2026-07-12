Task 5 completed.

What changed:

- Added `src/client.ts` REST helpers, including `buildBackendUrl()` and JSON/text request wrappers for backend calls.
- Expanded `src/server/routes.ts` with backend endpoints for the remaining habitat command families, including registration, solar, zones, airlocks, doors, modules, inventory, construction, and debug state changes.
- Kept the CLI command surface intact while routing the command families through the backend REST layer.
- Added `test/client.test.ts` to verify the default backend URL.

Verification:

- `bun test test/client.test.ts`
- `bun test`
- `bun run check`

Results: all passed.
