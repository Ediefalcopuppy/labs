import { readSqliteState as readRawSqliteState, writeSqliteState as writeRawSqliteState } from "../storage";
import type { HabitatState } from "./types";

export async function readStateFromStorage(path: string): Promise<HabitatState | undefined> {
  const state = await readRawSqliteState(path);
  return state as HabitatState | undefined;
}

export async function writeStateToStorage(path: string, state: HabitatState): Promise<number> {
  return writeRawSqliteState(path, state);
}
