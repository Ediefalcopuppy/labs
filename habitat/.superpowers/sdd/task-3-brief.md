# Task 3: CLI command wiring

Modify `src/index.ts` only unless a tiny formatting helper module is needed.

Add Commander commands that call the existing backend helpers (never direct state storage or Kepler transport):
- `habitat human list`
- `habitat human move <human-id> <module-id>`
- `habitat eva status`
- `habitat eva deploy <human-id>`
- `habitat eva move <x> <y>`
- `habitat eva dock`
- `habitat collect <quantity-kg>`
- `habitat alert list`
- `habitat alert acknowledge <alert-id>`

Use `postBackendCommand`, `getBackendCommand`, and existing integer/quantity parsers. Default output should be readable and colored consistently with existing CLI output; add `--json` to list/status commands where the file’s existing conventions support it. Render registration `starterHumans` and `contacts` in `habitat registration details` without dropping fields. Run `bunx tsc -p tsconfig.json --noEmit` and basic `--help` checks. Write `.superpowers/sdd/task-3-report.md`.
