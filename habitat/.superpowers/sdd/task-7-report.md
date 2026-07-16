# Task 7 report: saved-position resource scans

Implemented the scan extension so `habitat scan --strength <0-100> --radius <0-5>` can use the persisted deployed EVA position. Explicit `--x` and `--y` remain supported for compatibility; they must be supplied together. If coordinates are omitted while no EVA is deployed, the backend returns a clear validation error.

## Changes

- Made `--x` and `--y` optional for both `habitat scan` and `habitat resource scan`.
- Updated `POST /commands/resource/scan` to resolve omitted coordinates from `state.eva.x` and `state.eva.y`.
- Kept sensor strength and radius validation unchanged.
- Added regression tests for saved-position resolution and the undeployed-EVA error.

## Verification

- `bun test`: 34 passed, 0 failed.
- `bunx tsc -p tsconfig.json --noEmit`: passed.
