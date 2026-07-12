# Full Proxy API Design for Habitat CLI

## Goal

Move the Habitat CLI to a REST-backed architecture where the backend owns all mutable state, SQLite persistence, Kepler integration, construction logic, inventory behavior, power simulation, and command execution. The CLI becomes a thin client that parses commands, calls the backend, and formats output.

## Current State

The current CLI mixes several responsibilities:

- `src/index.ts` wires commands and also implements much of the behavior for module, inventory, construction, power, blueprint, and Kepler-related flows.
- `src/storage.ts` owns SQLite persistence for habitat state.
- `src/kepler-client.ts` owns Kepler HTTP access and response normalization.
- `src/construction.ts` contains reusable construction, power, and module-related helpers, but is still part of the same local process.

That structure is workable for a local CLI, but it creates a broad “catch-all” boundary. The full proxy split moves that complexity behind REST so the CLI no longer needs direct access to storage or Kepler.

## Proposed Boundary

The backend becomes the source of truth for:

- habitat state
- SQLite persistence
- Kepler catalog, registration, and solar requests
- construction and module mutation logic
- inventory behavior
- power simulation and ticking
- blueprint refresh and lookup

The CLI keeps:

- command parsing and option validation
- request construction
- response formatting
- user-facing error display
- local configuration for backend URL and auth

## API Shape

The API should be command-oriented where state changes are explicit, and resource-oriented where the CLI is mostly reading data.

### Read endpoints

- `GET /state`
  - returns a full habitat snapshot for status-style views
- `GET /modules`
- `GET /inventory`
- `GET /construction`
- `GET /power`
- `GET /blueprints`
- `GET /registration`

### Mutation endpoints

- `POST /commands/migrate`
  - initializes backend state or runs any one-time migration logic
- `POST /commands/register`
  - performs Kepler-backed registration and stores the result
- `POST /commands/link`
  - refreshes or links habitat identity against Kepler
- `POST /commands/solar`
  - fetches current solar data through the backend and updates state
- `POST /commands/blueprints/refresh`
  - refreshes blueprint catalog from Kepler
- `POST /commands/construct`
  - starts a construction job from a blueprint
- `POST /commands/module/create`
  - creates a module from a blueprint and persisted state
- `POST /commands/module/set-status`
  - updates module status
- `POST /commands/inventory/set`
  - sets inventory quantities
- `POST /commands/tick`
  - advances power simulation, construction progress, and any time-based state

## Responsibility Split

### Backend responsibilities

The backend should own all rules that decide what state changes are legal and how those changes are applied. That includes:

- blueprint validation
- construction job creation and completion
- inventory spending
- power draw and charge calculations
- module creation and lifecycle changes
- battery behavior
- Kepler request/response handling
- SQLite reads and writes

This keeps the CLI from becoming a second implementation of the domain rules.

### CLI responsibilities

The CLI should become a small orchestration layer:

- translate command arguments into REST requests
- display backend responses
- keep command names and user experience stable
- avoid duplicating business logic

## Local Development

During development, the backend should be started explicitly with:

```bash
bun run server
```

The CLI should connect to that running backend over a configured base URL. This keeps startup behavior predictable and makes it easy to inspect backend logs separately from CLI output.

## Data Flow

1. A user runs a CLI command.
2. The CLI converts it into a REST request.
3. The backend loads state from SQLite.
4. The backend applies command logic, including any Kepler calls.
5. The backend persists updated state.
6. The backend returns a normalized response.
7. The CLI formats and prints that response.

For `tick`, the backend also performs the simulation step before returning updated state.

## Tradeoffs

### Benefits

- The CLI becomes much smaller and easier to reason about.
- State, simulation, and external integration rules live in one place.
- The backend can serve multiple clients later, not just this CLI.
- Future command additions are easier because they only need backend behavior once.

### Costs

- The backend becomes a hard dependency for every command.
- Debugging shifts from local process calls to request/response tracing.
- The initial migration is larger because the backend must faithfully reproduce current behavior.
- Latency increases slightly because even simple reads now cross the network.

## Migration Strategy

The migration should preserve user-visible behavior while moving responsibilities in layers:

1. Introduce backend contracts for state reads and command execution.
2. Move SQLite ownership into the backend.
3. Move Kepler calls into the backend.
4. Move construction, inventory, module, and power logic into backend handlers.
5. Replace CLI internals with API clients while keeping command names stable.
6. Remove now-redundant local state and integration code from the CLI.

## Non-Goals

- Redesigning the command surface at the same time as the backend split
- Changing game or habitat rules as part of the migration
- Introducing multiple backend services before the first proxy split lands
- Reworking storage format beyond what is necessary to support backend ownership

## Open Questions

- Whether the backend should expose one generic command endpoint or separate endpoints per command family.
- Whether the CLI should batch multiple reads for status screens or rely on a single `GET /state`.
- Whether the backend should return full updated state after every mutation or only the changed portions.

## Recommendation

Proceed with the full proxy API boundary. It gives the cleanest long-term architecture and matches the project’s current tendency to concentrate behavior in the CLI entrypoint. The main thing to watch is migration size, so the implementation should still be broken into small, verifiable steps.
