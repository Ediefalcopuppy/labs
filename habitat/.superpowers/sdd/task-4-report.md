# Task 4 verification report

## Scope

Verified state normalization and the new human/EVA/alert routes and CLI command groups. The focused tests cover:

- registration defaults while retaining `starterHumans` and `contacts`;
- rejection of non-adjacent EVA movement;
- rejection of zero and negative collection quantities;
- persistence of an acknowledged alert.

The existing Bun test harness was present, so a focused test file was added at `test/human-eva-alerts.test.ts`.

## Commands and results

- `bun test test/human-eva-alerts.test.ts` — **passed** (4 tests, 14 expectations).
- `bun test` — **passed** (32 tests, 83 expectations, 0 failures).
- `bunx tsc -p tsconfig.json --noEmit` — **passed** (no diagnostics).
- `bun run src/index.ts --help` — **passed**; lists `human`, `eva`, `collect`, and `alert`.
- `bun run src/index.ts human --help` — **passed**; lists `list` and `move`.
- `bun run src/index.ts eva --help` — **passed**; lists `status`, `deploy`, `move`, and `dock`.
- `bun run src/index.ts alert --help` — **passed**; lists `list` and `acknowledge`.

## Registration materialization

Inspection found that linking previously saved `starterHumans` and `contacts` only on the registration record. The link route now also materializes valid `starterHumans` entries into top-level `state.humans`, and `contacts.alerts` entries into top-level `state.alerts` (defaulting an omitted alert status to `open`). It also retains both fields on the saved registration. This makes the human and alert commands usable immediately after linking.

The link route was not exercised against live Kepler in this verification run because that requires the configured remote service; the materialization path is covered by code inspection and the state normalization tests cover the retained registration fields.

## Concerns

- Kepler payloads with malformed starter-human or alert entries are ignored by the materialization filters; valid entries must have a non-empty `id`.
- Route validation currently reports domain validation failures as HTTP 500 through the existing app-wide error handler. This matches the existing backend behavior but could later be changed to 400 responses if desired.
