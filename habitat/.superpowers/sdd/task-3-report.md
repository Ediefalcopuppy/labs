# Task 3 report: CLI command wiring

Implemented the backend-only Commander wiring in `src/index.ts` for:

- `human list` and `human move <human-id> <module-id>`
- `eva status`, `eva deploy <human-id>`, `eva move <x> <y>`, and `eva dock`
- `collect <quantity-kg>`
- `alert list` and `alert acknowledge <alert-id>`

All new commands use `getBackendCommand` or `postBackendCommand`; no direct state or Kepler transport was added. List/status commands accept `--json`. Human-readable output uses the existing object formatter and color helpers. Registration details and `status` now render saved `starterHumans` and `contacts` fields while retaining the live Kepler payload.

Verification:

- `bunx tsc -p tsconfig.json --noEmit` passed.
- `bun src/index.ts human --help` passed.
- `bun src/index.ts eva --help` passed.
- `bun src/index.ts alert --help` passed.
- `bun src/index.ts collect --help` passed.

Notes:

- Backend mutation responses are intentionally treated as opaque; the CLI prints concise success messages so command wiring remains transport-focused.
- Quantity parsing accepts finite non-negative numbers; the backend enforces the strictly-positive collection rule.
