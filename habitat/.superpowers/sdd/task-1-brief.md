# Task 1: State models and normalization

Modify `src/state/types.ts`, `src/state/service.ts`, and `src/kepler/service.ts`.

Add `HabitatHuman`, `EvaState`, and `HabitatAlert` types; optional registration `starterHumans` and `contacts`; and top-level `humans`, `eva`, and `alerts` state. Normalize missing values to empty collections and a docked EVA at `(0,0)`. Preserve raw Kepler registration payloads when fetching details. Keep existing state backwards compatible. Run `bunx tsc -p tsconfig.json --noEmit`.

Use local Habitat simulation semantics: human/EVA/alert state is persisted by Habitat, not sent to undocumented Kepler mutation endpoints. Write a report to `.superpowers/sdd/task-1-report.md` with status, commit hash, tests, and concerns.
