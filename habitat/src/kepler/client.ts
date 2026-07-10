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
