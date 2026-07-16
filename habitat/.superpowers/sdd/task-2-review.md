# Task 2 review: backend domain routes

## Result

- Spec: ✅
- Quality: ✅ (minor non-blocking concern noted below)
- Approval: ✅ Approved

## Checks

- All requested human, EVA, collection, and alert routes are present.
- Mutations read and save through `stateService`; no Kepler write endpoints are called.
- Human IDs, module IDs, and alert IDs are checked against persisted state.
- EVA deployment rejects duplicate deployment and requires an existing human.
- EVA movement validates integer coordinates and Manhattan adjacency.
- Collection requires a deployed EVA and positive finite quantity, and clamps against local `inventory.material` when present.
- Docking resets EVA to `(0, 0)`, clears deployment/carried resources, and unloads carried quantities into inventory.
- Every added route logs an action.
- `bunx tsc -p tsconfig.json --noEmit` passes.

## Non-blocking concern

`human/move` accepts a module name/display name as an alias but persists the submitted value rather than the matched module's canonical ID. This does not violate the route contract when callers submit IDs, but canonicalizing to `module.id` would make persisted state more consistent.
