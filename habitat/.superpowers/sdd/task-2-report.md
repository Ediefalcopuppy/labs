# Task 2 report: backend domain routes

Implemented the local Habitat simulation routes in `src/server/routes.ts`:

- Human listing and module movement with ID/module validation.
- EVA status, deployment, adjacent-grid movement, collection, and docking.
- Alert listing and acknowledgement.
- Every route emits an action log and persists mutations through `stateService`.

EVA and collection behavior is local-only; no undocumented Kepler write endpoints are called. Deployment starts at the saved human coordinates when those coordinates are integer values, otherwise `(0, 0)`. Collection uses the generic `material` inventory key when local material is represented and clamps collection to the available amount.

Verification:

```text
bunx tsc -p tsconfig.json --noEmit
```

Result: passed with no TypeScript errors.

Concerns for CLI integration: mutation routes return the complete normalized Habitat state, while status/list routes return their focused collection/state. The CLI should select the relevant field when rendering mutation responses.
