# Task 2: Backend domain routes

Modify `src/server/routes.ts` only unless a small focused backend module is needed.

Add backend routes for persisted Habitat simulation:
- GET `/commands/human/list`, POST `/commands/human/move` with `{humanId,moduleId}`.
- GET `/commands/eva/status`, POST `/commands/eva/deploy` with `{humanId}`, POST `/commands/eva/move` with `{x,y}`, POST `/commands/eva/dock`.
- POST `/commands/collect` with `{quantityKg}`; require deployed EVA and a positive finite quantity, decrementing no more than available local material if represented.
- GET `/commands/alert/list`, POST `/commands/alert/:alertId/acknowledge`.

Use the types/defaults in `src/state/types.ts`. Movement must be grid-adjacent (Manhattan distance 1) and EVA deployment must select an existing human and reject duplicate deployment. Docking returns EVA to `(0,0)`, clears deployment, and unloads carried resources into inventory. Every route must log an action and persist via `stateService`. Keep all behavior local; do not call undocumented Kepler write endpoints. Run `bunx tsc -p tsconfig.json --noEmit` and write `.superpowers/sdd/task-2-report.md`.
