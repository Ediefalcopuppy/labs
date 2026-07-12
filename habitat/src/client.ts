const defaultBackendUrl = "http://127.0.0.1:3000";

export function buildBackendUrl(): string {
  return process.env.HABITAT_BACKEND_URL ?? defaultBackendUrl;
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

export async function getBackendState<T>(): Promise<T> {
  return (await requestBackendJson("/state")) as T;
}

export async function saveBackendState<T>(state: T): Promise<T> {
  return (await requestBackendJson("/state", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(state),
  })) as T;
}

export async function resetBackendState<T>(): Promise<T> {
  return (await requestBackendJson("/state", {
    method: "DELETE",
  })) as T;
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

export async function postBackendCommand<T>(path: string, body?: unknown): Promise<T> {
  return (await postBackendJson(path, body)) as T;
}

export async function getBackendCommand<T>(path: string): Promise<T> {
  return (await fetchBackendJson(path)) as T;
}

export async function deleteBackendCommand<T>(path: string): Promise<T> {
  return (await deleteBackendJson(path)) as T;
}
