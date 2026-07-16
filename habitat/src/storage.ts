import { Database } from "bun:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_KEY = "habitat";

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function readSqliteState(path: string): Promise<unknown | undefined> {
  try {
    const database = new Database(path, { create: false, readwrite: true });
    database.run("CREATE TABLE IF NOT EXISTS habitat_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
    const row = database
      .query<{ value_json: string }, [string]>("SELECT value_json FROM habitat_state WHERE key = ?")
      .get(STATE_KEY);
    database.close();
    return row ? JSON.parse(row.value_json) as unknown : undefined;
  } catch (error) {
    if (error instanceof Error && error.message.includes("unable to open database file")) {
      return undefined;
    }
    throw error;
  }
}

export async function writeSqliteState(path: string, state: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const database = new Database(path);
  try {
    database.run("BEGIN IMMEDIATE");
    database.run("CREATE TABLE IF NOT EXISTS habitat_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
    database
      .query("INSERT INTO habitat_state (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(STATE_KEY, JSON.stringify(state));
    database.run("COMMIT");
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
