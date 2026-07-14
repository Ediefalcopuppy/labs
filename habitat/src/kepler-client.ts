const backendBaseUrl = process.env.HABITAT_API_BASE_URL ?? process.env.HABITAT_BACKEND_URL ?? "http://127.0.0.1:3000";

export type { KeplerBlueprintCatalogEntry, KeplerHabitat, KeplerResourceCatalogEntry } from "./kepler/service";

async function fetchBackendJson(path: string): Promise<unknown> {
  const response = await fetch(`${backendBaseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch Habitat backend data: ${response.status} ${response.statusText}.`);
  }

  return response.json();
}

export async function fetchKeplerBlueprintCatalog(): Promise<
  import("./kepler/service").KeplerBlueprintCatalogEntry[]
> {
  return (await fetchBackendJson("/kepler/blueprints")) as import("./kepler/service").KeplerBlueprintCatalogEntry[];
}

export async function fetchKeplerResourceCatalog(): Promise<
  import("./kepler/service").KeplerResourceCatalogEntry[]
> {
  return (await fetchBackendJson("/kepler/resources")) as import("./kepler/service").KeplerResourceCatalogEntry[];
}

export async function fetchKeplerSolarIrradiance(): Promise<number> {
  const payload = (await fetchBackendJson("/kepler/solar")) as { irradiance?: unknown };
  if (typeof payload.irradiance !== "number") {
    throw new Error("Habitat backend did not return a valid solar irradiance value.");
  }
  return payload.irradiance;
}

export async function fetchKeplerHabitatRegistration(
  habitatId: string,
): Promise<import("./kepler/service").KeplerHabitat> {
  return (await fetchBackendJson(`/kepler/habitats/${encodeURIComponent(habitatId)}/registration`)) as import("./kepler/service").KeplerHabitat;
}
