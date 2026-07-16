# Human EVA and Alert Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add backend-owned human, EVA, collection, and alert commands while preserving registration details such as `starterHumans` and `contacts.alerts`.

**Architecture:** Extend persisted Habitat state with normalized humans, explorer, and alerts. Add focused Hono command routes that validate and mutate state; CLI commands call those routes through the existing backend client and render human-readable output by default with `--json` where useful.

**Tech Stack:** TypeScript, Bun, Hono, Commander, SQLite-backed state service.

## Global Constraints

- Kepler remains the source of registration payloads; no undocumented Kepler write endpoints are assumed.
- CLI transport logic stays in backend client helpers, not command wiring.
- Movement is grid-based; EVA movement must be adjacent and docking returns to `(0, 0)`.

### Task 1: State models and normalization

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/service.ts`
- Modify: `src/kepler/service.ts`

- [ ] Add `HabitatHuman`, `EvaState`, and `HabitatAlert` types, optional registration `starterHumans` and `contacts`, and top-level `humans`, `eva`, and `alerts` state.
- [ ] Normalize missing values to empty collections and a docked EVA at `(0,0)`.
- [ ] Preserve raw Kepler registration payloads when fetching details.
- [ ] Run `bunx tsc -p tsconfig.json --noEmit`.

### Task 2: Backend domain routes

**Files:**
- Modify: `src/server/routes.ts`

- [ ] Add GET/POST routes for humans, EVA status/deploy/move/dock, collection, and alerts.
- [ ] Hydrate starter humans and registration alerts when linking.
- [ ] Validate IDs, quantities, adjacency, dock/deploy preconditions, and acknowledgement transitions.
- [ ] Log each action using existing request/action logging.
- [ ] Run TypeScript checks and route-level smoke requests against `createApp`.

### Task 3: CLI command wiring

**Files:**
- Modify: `src/index.ts`

- [ ] Add `human list/move`, `eva status/deploy/move/dock`, `collect`, and `alert list/acknowledge` commands.
- [ ] Use backend helpers for all command calls; support JSON output where existing conventions use it.
- [ ] Render starter humans and alerts in registration details/status without leaking credentials.
- [ ] Run CLI help checks and TypeScript build.

### Task 4: Verification

**Files:**
- Modify: existing test files if present; otherwise add focused tests under `test/`.

- [ ] Test normalization defaults, adjacent movement rejection, collection quantity validation, and alert acknowledgement.
- [ ] Run the full available test suite and `bunx tsc -p tsconfig.json --noEmit`.

