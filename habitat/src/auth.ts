import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type UserRole = "user" | "admin";
export type User = { username: string; role: UserRole; createdAt: string };

const SESSION_COOKIE = "habitat_session";
const sessions = new Map<string, User>();

function database(path: string): Database {
  const db = new Database(path);
  db.run("CREATE TABLE IF NOT EXISTS habitat_users (username TEXT PRIMARY KEY, role TEXT NOT NULL, created_at TEXT NOT NULL)");
  return db;
}

function normalizeUsername(input: unknown): string {
  if (typeof input !== "string") throw new Error("Username is required.");
  const username = input.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/.test(username)) {
    throw new Error("Username must be 2–32 characters and use letters, numbers, dots, dashes, or underscores.");
  }
  return username;
}

function rowToUser(row: { username: string; role: string; created_at: string }): User {
  return { username: row.username, role: row.role === "admin" ? "admin" : "user", createdAt: row.created_at };
}

function isBootstrapAdmin(username: string): boolean {
  const configured = process.env.HABITAT_ADMIN_USERNAME ?? process.env.HABITAT_BOOTSTRAP_ADMIN_USERNAME;
  return Boolean(configured && configured.trim().toLowerCase() === username.toLowerCase());
}

export function createAuthService(storagePath: string) {
  async function withDatabase<T>(operation: (db: Database) => T): Promise<T> {
    await mkdir(dirname(storagePath), { recursive: true });
    const db = database(storagePath);
    try { return operation(db); } finally { db.close(); }
  }

  async function findUser(username: string): Promise<User | undefined> {
    const user = await withDatabase((db) => {
      const row = db.query<{ username: string; role: string; created_at: string }, [string]>("SELECT username, role, created_at FROM habitat_users WHERE username = ?").get(username);
      return row ? rowToUser(row) : undefined;
    });
    if (user && isBootstrapAdmin(user.username) && user.role !== "admin") {
      await withDatabase((db) => db.query("UPDATE habitat_users SET role = 'admin' WHERE username = ?").run(user.username));
      return { ...user, role: "admin" };
    }
    return user;
  }

  return {
    async signup(input: unknown): Promise<User> {
      const username = normalizeUsername((input as { username?: unknown })?.username);
      const existing = await findUser(username);
      if (existing) throw new Error(`Username '${username}' is already registered.`);
      const role: UserRole = isBootstrapAdmin(username) ? "admin" : "user";
      const createdAt = new Date().toISOString();
      await withDatabase((db) => db.query("INSERT INTO habitat_users (username, role, created_at) VALUES (?, ?, ?)").run(username, role, createdAt));
      return { username, role, createdAt };
    },
    async login(input: unknown): Promise<User> {
      const username = normalizeUsername((input as { username?: unknown })?.username);
      const user = await findUser(username);
      if (!user) throw new Error("No account exists for that username. Sign up first.");
      return user;
    },
    createSession(user: User): string { const token = randomUUID(); sessions.set(token, user); return token; },
    getUserFromRequest(request: Request): User | undefined {
      const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
      return cookie ? sessions.get(decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1))) : undefined;
    },
    clearSession(request: Request): void {
      const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
      if (cookie) sessions.delete(decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1)));
    },
    cookie(token: string): string { return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`; },
    expiredCookie(): string { return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`; },
    async listUsers(): Promise<User[]> { return withDatabase((db) => db.query<{ username: string; role: string; created_at: string }, []>("SELECT username, role, created_at FROM habitat_users ORDER BY username").all().map(rowToUser)); },
    async setRole(usernameInput: string, role: UserRole): Promise<User> {
      const username = normalizeUsername(usernameInput);
      if (role !== "user" && role !== "admin") throw new Error("Role must be user or admin.");
      const user = await findUser(username);
      if (!user) throw new Error(`No user named '${username}' exists.`);
      await withDatabase((db) => db.query("UPDATE habitat_users SET role = ? WHERE username = ?").run(role, username));
      for (const [token, sessionUser] of sessions) if (sessionUser.username === username) sessions.set(token, { ...sessionUser, role });
      return { ...user, role };
    },
  };
}

export { SESSION_COOKIE };
