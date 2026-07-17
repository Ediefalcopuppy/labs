const keplerBaseUrl = "https://planet.turingguild.com";

function readKeplerToken(commandHint: string): string {
  const token = process.env.KEPLER_PLANET_TOKEN;

  if (!token) {
    throw new Error(`Set KEPLER_PLANET_TOKEN before running '${commandHint}'.`);
  }

  return token;
}

export async function fetchKeplerJson(path: string, commandHint: string): Promise<unknown> {
  const token = readKeplerToken(commandHint);
  const response = await fetch(`${keplerBaseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Kepler data: ${response.status} ${response.statusText}.`);
  }

  return response.json();
}

export async function postKeplerJson(
  path: string,
  body: unknown,
  commandHint: string,
): Promise<unknown> {
  const token = readKeplerToken(commandHint);
  const response = await fetch(`${keplerBaseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Kepler data: ${response.status} ${response.statusText}.`);
  }

  return response.json();
}

export async function patchKeplerJson(
  path: string,
  body: unknown,
  commandHint: string,
): Promise<unknown> {
  const token = readKeplerToken(commandHint);
  const response = await fetch(`${keplerBaseUrl}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to update Kepler data: ${response.status} ${response.statusText}.`);
  }

  return response.json();
}
