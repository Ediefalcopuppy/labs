# Task 5 report: route CLI link through backend

## Change

Updated `habitat link --id <habitatId>` to call the backend `POST /commands/link` command through `postBackendCommand`. The CLI keeps its existing local-registration guard and prints the linked habitat name and ID from the backend's saved registration response. Kepler lookup and registration materialization therefore remain backend-owned, including `starterHumans` and `contacts.alerts`.

No focused CLI test was added because the existing test harness does not provide an isolated subprocess/backend fixture for Commander command actions; the backend route already has the relevant state behavior covered by the existing suite.

## Verification

- `bun test` — passed (32 tests, 0 failures).
- `bunx tsc -p tsconfig.json --noEmit` — passed.

The repeated alert acknowledgement behavior remains safely idempotent: acknowledging an already acknowledged alert sets the same status and persists without changing other state.
