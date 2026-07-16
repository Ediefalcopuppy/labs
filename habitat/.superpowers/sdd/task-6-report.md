# Task 6 report

## Change

Updated `habitat module delete <name>` so the CLI delegates deletion to the Habitat backend at `DELETE /commands/module/:name`.

The argument is URI-encoded before being appended to the route. The backend already accepts a module's canonical `id`, internal `name`, or `displayName`, so actual module IDs and existing aliases are supported consistently.

## Verification

- `bunx tsc -p tsconfig.json --noEmit` — passed.
- `bun run src/index.ts module delete --help` — passed; documents the argument as module name, ID, or display name.
