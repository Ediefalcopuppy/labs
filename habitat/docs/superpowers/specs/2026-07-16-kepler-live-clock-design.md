# Kepler Live Clock Design

## Goal

Connect the existing Habitat backend to Kepler's live planet clock without replacing its Hono API, SQLite-backed simulation state, CLI, dashboard, or manual tick behavior. The backend owns one authenticated WebSocket, applies only live future notices while listening is enabled, and exposes status, controls, and a token-free local SSE feed.

## Verified Kepler contract

The live `2026-06-24` contract requires the course bearer token for `POST /habitats/register`. Registration accepts `displayName` and a stable `habitatUuid`, then returns a Habitat-specific `apiToken`, `streamUrl`, stream metadata, starter state, contracts, and blueprints. The stream token is distinct from the registration bearer token.

The WebSocket upgrade itself is unauthenticated. The backend sends `hello` with the saved `apiToken` and the advertised `ticks` subscription. It does not put the token in the URL and does not send the optional `lastAppliedPlanetTick`, because this Habitat intentionally does not request catch-up. The client validates the full `hello_ack`, including the saved Habitat ID, before accepting `planet_tick` messages.

## Approaches considered

1. Store clock fields and the token inside the existing JSON state blob. This is the smallest change and makes a tick/cursor update naturally atomic, but it exposes the token through existing state endpoints and makes the migration implicit.
2. Add versioned clock and registration-secret tables while retaining the existing JSON simulation row. This keeps the token in one controlled location, provides an explicit additive migration, and permits a transaction to update simulation state and the clock cursor together. This is the selected approach.
3. Build a separate clock database or process. This isolates failures but complicates deployment, makes atomic state advancement harder, and violates the existing single-backend architecture.

## Persistence

A versioned migration creates:

- `schema_migrations`, which records applied additive migrations.
- `habitat_clock_state`, a singleton row containing mode, listening intent, connection state, latest absolute Kepler tick, latest applied `advancedBy`, last connection/message timestamps, and latest error.
- `habitat_registration_secrets`, keyed by Habitat ID, containing the one authoritative saved stream token.

Non-secret registration stream metadata remains on `HabitatRegistration`: stable `habitatUuid`, `streamUrl`, protocol version, advertised subscriptions, registration-time current tick, interval, ticks per pulse, and stream status. Existing JSON state remains intact.

Registration writes the updated Habitat state and stream token in one SQLite transaction. A pre-stream registration is upgraded in place by deriving its original UUID from the existing `habitat_<uuid-with-underscores>` identifier, reusing its saved display name, and calling registration once. New registrations persist the generated UUID for future reuse.

Public `/state` and dashboard reads never contain the token. The explicit CLI status request asks the local backend for the complete registration status and prints the full saved stream token as required.

## Runtime components

- A shared simulation operation advances construction, power, batteries, and related state for exactly `count` ticks. Manual and Kepler paths both call it.
- A clock repository performs clock reads/writes, registration-secret storage, and atomic simulation-plus-cursor commits.
- A clock service serializes mode changes and tick application. It rejects manual ticks whenever persisted listener intent is on, even while connecting or reconnecting.
- A focused Kepler WebSocket transport/state machine sends `hello`, validates `hello_ack`, validates notices, rejects pre-ack messages, deduplicates by absolute tick, and reconnects after unexpected closure.
- A local event hub broadcasts only newly observed valid notices to current subscribers. Events contain `tick`, full `advancedBy`, `issuedAt`, and `applied`, never the token.

Turning listening on persists Kepler mode before opening a socket. Turning it off synchronously disables new notice acceptance and closes the socket, waits for any queued tick to finish, then persists manual mode. Connection failures update status but do not stop REST service.

On initial connection or reconnect, the acknowledged `currentTick` becomes the session floor. Notices at or below that floor, and notices at or below the saved cursor, are not applied. This deliberately prevents replay of ticks missed before listening or while disconnected.

## API and CLI

The backend adds:

- `GET /clock/status`
- `POST /clock/listen/on`
- `POST /clock/listen/off`
- `GET /clock/events` as a long-running SSE response

The CLI adds global `--json` and `--jsonl` output modes and:

- `habitat clock status`
- `habitat clock listen on|off`
- `habitat clock watch`

`clock watch` consumes only the local SSE endpoint. Ctrl+C aborts that request without affecting the backend. The dashboard adds local clock status/listen commands and the Vite proxy adds `/clock`; it never connects to Kepler directly.

## Validation and errors

`hello_ack` must contain the documented required fields and match the saved Habitat ID. `planet_tick` must be JSON with the exact message type, nonnegative whole-number absolute ticks, a positive whole-number `advancedBy`, a valid `secondsPerTick`, and a valid timestamp. The tick delta must agree with `advancedBy`.

Malformed JSON, invalid acknowledgements, invalid notices, duplicates, older notices, and stale messages from replaced sockets do not mutate simulation state. Useful redacted errors are persisted. No code path logs the stream token.

## Lifecycle and testing

Server startup runs migrations, creates one clock service, and resumes a persisted Kepler listener. SIGINT/SIGTERM stop reconnect scheduling, close the WebSocket, close SSE subscribers, and stop the HTTP server cleanly while preserving desired listening mode for restarts.

Automated tests cover migration preservation, registration persistence/upgrade, status output, protocol validation, authentication, pre-ack rejection, Habitat mismatch, all required `advancedBy` cases, deduplication, no catch-up, reconnect, shutdown, SSE/watch behavior, manual rejection, atomic restart persistence, and token absence. Final verification runs the full Bun test suite, TypeScript check, web build, CLI smoke tests, service/restart checks where the host supports them, and a secret scan of the staged diff.
