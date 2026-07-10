## Task 3 Report: Move Kepler integration behind backend services

Completed:

- Added a backend Kepler client in `src/kepler/client.ts` that is responsible for the actual HTTP calls to `planet.turingguild.com`.
- Added a backend Kepler service in `src/kepler/service.ts` that normalizes blueprint, resource, solar, and habitat-registration responses.
- Added backend Kepler routes in `src/server/routes.ts` so catalog reads, solar fetches, and habitat registration flow through the server layer.
- Converted `src/kepler-client.ts` into a frontend/backend proxy client that talks to the local Habitat backend instead of Kepler directly.
- Updated shared Kepler type imports in `src/construction.ts` and `src/state/types.ts` to use the new service boundary.
- Added `test/kepler-service.test.ts` to verify blueprint normalization.

Verification:

- `bun test test/kepler-service.test.ts`
- `bun run check`

Notes:

- The backend server is now the only code path that reaches `planet.turingguild.com`.
- The CLI-facing `kepler-client.ts` now depends on backend routes rather than Kepler’s external API.
