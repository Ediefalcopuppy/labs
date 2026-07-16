# Task 5: Route CLI link through backend

Fix the blocking integration gap identified in final review. `habitat link` in `src/index.ts` must call the backend `/commands/link` command rather than fetching Kepler directly and saving state locally, so the backend materializes `starterHumans` and `contacts.alerts` into top-level humans/alerts. Preserve the existing CLI validation and readable success output. Use the existing backend command helper. Add or update a focused test if feasible, run `bun test` and `bunx tsc -p tsconfig.json --noEmit`, and write `.superpowers/sdd/task-5-report.md`.
