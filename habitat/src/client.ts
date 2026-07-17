import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { operatorTokenPath } from "./server/operator";

const defaultBackendUrl = "http://127.0.0.1:3000";
const BACKEND_STATE_ETAG = Symbol("backend-state-etag");

type BackendStateEtagCarrier = {
  [BACKEND_STATE_ETAG]?: string;
};

export function buildBackendUrl(): string {
  return process.env.HABITAT_API_BASE_URL ?? process.env.HABITAT_BACKEND_URL ?? defaultBackendUrl;
}

async function readOperatorToken(): Promise<string> {
  const configured = process.env.HABITAT_OPERATOR_TOKEN;
  if (configured) return configured;
  const sqlitePath = process.env.HABITAT_SQLITE_PATH ??
    join(process.cwd(), ".habitat", "habitat.sqlite");
  return (await readFile(operatorTokenPath(sqlitePath), "utf8")).trim();
}

function requireLoopbackBackend(): void {
  const backend = new URL(buildBackendUrl());
  const hostname = backend.hostname.replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.split(".")[0] === "127");
  if (
    backend.username ||
    backend.password ||
    !loopback
  ) {
    throw new Error("The token-bearing Habitat status command must use a loopback backend URL.");
  }
}

async function requestBackendJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${buildBackendUrl()}${path}`, init);

  if (!response.ok) {
    throw new Error(`Failed to contact Habitat backend: ${response.status} ${response.statusText}.`);
  }

  return response.json();
}

async function requestBackendText(path: string, init?: RequestInit): Promise<string> {
  const response = await fetch(`${buildBackendUrl()}${path}`, init);

  if (!response.ok) {
    throw new Error(`Failed to contact Habitat backend: ${response.status} ${response.statusText}.`);
  }

  return response.text();
}

function attachBackendStateEtag<T>(state: T, etag: string | null): T {
  if (!state || typeof state !== "object") {
    throw new Error("Habitat backend returned an invalid state body.");
  }
  if (!etag) {
    throw new Error("Habitat backend did not return a state ETag.");
  }
  Object.defineProperty(state, BACKEND_STATE_ETAG, {
    configurable: true,
    enumerable: false,
    value: etag,
    writable: false,
  });
  return state;
}

function getBackendStateEtag(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  return (state as BackendStateEtagCarrier)[BACKEND_STATE_ETAG];
}

async function requestBackendState<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${buildBackendUrl()}${path}`, init);
  if (!response.ok) {
    throw new Error(`Failed to contact Habitat backend: ${response.status} ${response.statusText}.`);
  }
  return attachBackendStateEtag(await response.json() as T, response.headers.get("etag"));
}

export async function getBackendState<T>(): Promise<T> {
  return requestBackendState<T>("/state");
}

export async function saveBackendState<T>(state: T): Promise<T> {
  const etag = getBackendStateEtag(state);
  if (!etag) {
    throw new Error("Please load the state from the Habitat backend before saving it.");
  }
  return requestBackendState<T>("/state", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "if-match": etag,
    },
    body: JSON.stringify(state),
  });
}

export async function resetBackendState<T>(): Promise<T> {
  return requestBackendState<T>("/state", {
    method: "DELETE",
  });
}

export async function fetchBackendJson(path: string): Promise<unknown> {
  return requestBackendJson(path);
}

export async function postBackendJson(path: string, body?: unknown): Promise<unknown> {
  return requestBackendJson(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function putBackendJson(path: string, body?: unknown): Promise<unknown> {
  return requestBackendJson(path, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function deleteBackendJson(path: string): Promise<unknown> {
  return requestBackendJson(path, { method: "DELETE" });
}

export async function fetchBackendText(path: string): Promise<string> {
  return requestBackendText(path);
}

export async function fetchBackendEventStream(
  path: string,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(`${buildBackendUrl()}${path}`, {
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to contact Habitat backend: ${response.status} ${response.statusText}.`);
  }
  return response;
}

export async function postBackendCommand<T>(path: string, body?: unknown): Promise<T> {
  return (await postBackendJson(path, body)) as T;
}

export async function getBackendCommand<T>(path: string): Promise<T> {
  return (await fetchBackendJson(path)) as T;
}

export async function getLocalOperatorCommand<T>(path: string): Promise<T> {
  requireLoopbackBackend();
  const operatorToken = await readOperatorToken();
  return (await requestBackendJson(path, {
    headers: { authorization: `Bearer ${operatorToken}` },
  })) as T;
}

export async function deleteBackendCommand<T>(path: string): Promise<T> {
  return (await deleteBackendJson(path)) as T;
}
