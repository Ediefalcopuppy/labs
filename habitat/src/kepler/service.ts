import { fetchKeplerJson } from "./client";

export type KeplerHabitat = {
  id: string;
  habitatSlug: string;
  displayName: string;
  catalogVersion: string;
  status: string;
  lastSeenAt?: string | null;
  starterHumans?: unknown;
  contacts?: unknown;
};

type KeplerHabitatResponse = {
  habitat?: Partial<KeplerHabitat>;
};

type KeplerHabitatDetailsResponse = {
  habitat?: Record<string, unknown>;
  [key: string]: unknown;
};

export type KeplerBlueprintCatalogEntry = {
  id?: string;
  blueprintId: string;
  displayName: string;
  name?: string;
  description?: string;
  status?: string;
  output?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  productionCost?: Record<string, unknown>;
  requiredFacility?: Record<string, unknown>;
  buildTicks?: number;
  prerequisites?: string[];
  unlocks?: string[];
  repeatable?: boolean;
  level?: number | null;
  target?: Record<string, unknown>;
  facilityLevel?: Record<string, unknown>;
  attachmentPoints?: Record<string, unknown>;
  attachmentRequirements?: Record<string, unknown>[];
  runtimeAttributes?: Record<string, unknown>;
  capabilities?: string[];
};

type KeplerBlueprintCatalogResponse =
  | KeplerBlueprintCatalogEntry[]
  | {
      blueprints?: unknown;
      items?: unknown;
      data?: unknown;
    };

export type KeplerResourceCatalogEntry = {
  id?: string;
  resourceId?: string;
  displayName?: string;
  name?: string;
  description?: string;
  status?: string;
  capabilities?: string[];
  runtimeAttributes?: Record<string, unknown>;
};

type KeplerResourceCatalogResponse =
  | KeplerResourceCatalogEntry[]
  | {
      resources?: unknown;
      items?: unknown;
      data?: unknown;
    };

type KeplerSolarIrradianceResponse =
  | {
      solarIrradiance?: {
        wPerM2?: unknown;
        condition?: unknown;
      };
    }
  | {
      data?: {
        solarIrradiance?: {
          wPerM2?: unknown;
          condition?: unknown;
        };
      };
    };

function normalizeKeplerHabitat(value: Partial<KeplerHabitat>): KeplerHabitat {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("Kepler returned a habitat without a valid id.");
  }

  if (typeof value.habitatSlug !== "string" || value.habitatSlug.length === 0) {
    throw new Error("Kepler returned a habitat without a valid habitatSlug.");
  }

  if (typeof value.displayName !== "string" || value.displayName.length === 0) {
    throw new Error("Kepler returned a habitat without a valid displayName.");
  }

  if (typeof value.catalogVersion !== "string" || value.catalogVersion.length === 0) {
    throw new Error("Kepler returned a habitat without a valid catalogVersion.");
  }

  if (typeof value.status !== "string" || value.status.length === 0) {
    throw new Error("Kepler returned a habitat without a valid status.");
  }

  return {
    id: value.id,
    habitatSlug: value.habitatSlug,
    displayName: value.displayName,
    catalogVersion: value.catalogVersion,
    status: value.status,
    lastSeenAt:
      typeof value.lastSeenAt === "string" || value.lastSeenAt === null
        ? value.lastSeenAt
        : undefined,
    starterHumans: value.starterHumans,
    contacts: value.contacts,
  };
}

export function normalizeKeplerCatalog(
  entries: Array<Partial<KeplerBlueprintCatalogEntry> & { id?: string }>,
): KeplerBlueprintCatalogEntry[] {
  return entries.map((entry) => {
    const blueprintId = entry.blueprintId ?? entry.id;

    if (typeof blueprintId !== "string" || blueprintId.length === 0) {
      throw new Error("Kepler returned a blueprint without a valid blueprintId.");
    }

    const displayName =
      typeof entry.displayName === "string" && entry.displayName.length > 0
        ? entry.displayName
        : typeof entry.name === "string" && entry.name.length > 0
          ? entry.name
        : blueprintId;

    return {
      id: typeof entry.id === "string" ? entry.id : undefined,
      blueprintId,
      displayName,
      name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : displayName,
      description: typeof entry.description === "string" ? entry.description : undefined,
      status: typeof entry.status === "string" ? entry.status : undefined,
      output: entry.output,
      inputs: entry.inputs,
      productionCost: entry.productionCost,
      requiredFacility: entry.requiredFacility,
      buildTicks: typeof entry.buildTicks === "number" ? entry.buildTicks : undefined,
      prerequisites: Array.isArray(entry.prerequisites) ? entry.prerequisites : undefined,
      unlocks: Array.isArray(entry.unlocks) ? entry.unlocks : undefined,
      repeatable: typeof entry.repeatable === "boolean" ? entry.repeatable : undefined,
      level: typeof entry.level === "number" || entry.level === null ? entry.level : undefined,
      target: entry.target,
      facilityLevel: entry.facilityLevel,
      attachmentPoints: entry.attachmentPoints,
      attachmentRequirements: Array.isArray(entry.attachmentRequirements)
        ? entry.attachmentRequirements
        : undefined,
      runtimeAttributes: entry.runtimeAttributes,
      capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : undefined,
    };
  });
}

function extractBlueprintEntries(payload: unknown): KeplerBlueprintCatalogEntry[] {
  const candidates: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? [
          (payload as Record<string, unknown>).blueprints,
          (payload as Record<string, unknown>).items,
          (payload as Record<string, unknown>).data,
        ]
      : [];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return normalizeKeplerCatalog(
        candidate as Array<Partial<KeplerBlueprintCatalogEntry> & { id?: string }>,
      );
    }
  }

  throw new Error("Kepler blueprint catalog response did not include an array of blueprints.");
}

function normalizeResourceCatalogEntry(
  value: Partial<KeplerResourceCatalogEntry> & { id?: string },
): KeplerResourceCatalogEntry {
  const resourceId = value.resourceId ?? value.id ?? value.name;

  if (typeof resourceId !== "string" || resourceId.length === 0) {
    throw new Error("Kepler returned a resource without a valid id.");
  }

  const displayName =
    typeof value.displayName === "string" && value.displayName.length > 0
      ? value.displayName
      : typeof value.name === "string" && value.name.length > 0
        ? value.name
        : resourceId;

  return {
    id: typeof value.id === "string" ? value.id : undefined,
    resourceId,
    displayName,
    name: typeof value.name === "string" ? value.name : undefined,
    description: typeof value.description === "string" ? value.description : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    capabilities: Array.isArray(value.capabilities) ? value.capabilities : undefined,
    runtimeAttributes: value.runtimeAttributes,
  };
}

function extractResourceEntries(payload: unknown): KeplerResourceCatalogEntry[] {
  const candidates: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? [
          (payload as Record<string, unknown>).resources,
          (payload as Record<string, unknown>).items,
          (payload as Record<string, unknown>).data,
        ]
      : [];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map((entry) =>
        normalizeResourceCatalogEntry(entry as Partial<KeplerResourceCatalogEntry> & { id?: string }),
      );
    }
  }

  throw new Error("Kepler resource catalog response did not include an array of resources.");
}

function extractSolarIrradiance(payload: KeplerSolarIrradianceResponse): number {
  const candidate =
    payload && typeof payload === "object" && "solarIrradiance" in payload
      ? payload.solarIrradiance?.wPerM2
      : payload && typeof payload === "object" && "data" in payload
        ? payload.data?.solarIrradiance?.wPerM2
        : undefined;

  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw new Error("Kepler solar irradiance response did not include a valid numeric irradiance.");
  }

  return candidate;
}

export function normalizeKeplerHabitatRegistration(
  habitat: Partial<KeplerHabitat>,
): KeplerHabitat {
  return normalizeKeplerHabitat(habitat);
}

export async function fetchKeplerBlueprintCatalog(): Promise<KeplerBlueprintCatalogEntry[]> {
  const payload = (await fetchKeplerJson(
    "/catalog/blueprints",
    "habitat blueprint list",
  )) as KeplerBlueprintCatalogResponse;
  return extractBlueprintEntries(payload);
}

export async function fetchKeplerResourceCatalog(): Promise<KeplerResourceCatalogEntry[]> {
  const payload = (await fetchKeplerJson(
    "/catalog/resources",
    "habitat resource list",
  )) as KeplerResourceCatalogResponse;
  return extractResourceEntries(payload);
}

export async function fetchKeplerSolarIrradiance(): Promise<number> {
  const payload = (await fetchKeplerJson("/world/solar-irradiance", "habitat tick")) as KeplerSolarIrradianceResponse;
  return extractSolarIrradiance(payload);
}

export async function fetchKeplerHabitatRegistration(habitatId: string): Promise<KeplerHabitat> {
  const payload = (await fetchKeplerJson(
    `/habitats/${encodeURIComponent(habitatId)}/registration`,
    "habitat link --id <habitatId>",
  )) as KeplerHabitatResponse;

  if (!payload.habitat || typeof payload.habitat !== "object") {
    throw new Error("Kepler habitat registration response did not include a habitat object.");
  }

  return normalizeKeplerHabitat(payload.habitat);
}

export async function fetchKeplerHabitatRegistrationDetails(
  habitatId: string,
): Promise<unknown> {
  return (await fetchKeplerJson(
    `/habitats/${encodeURIComponent(habitatId)}/registration`,
    "habitat registration details",
  )) as KeplerHabitatDetailsResponse;
}

export async function fetchKeplerWorldScan(params: {
  habitatId: string;
  x: number;
  y: number;
  sensorStrength: number;
  radiusTiles: number;
}): Promise<unknown> {
  const search = new URLSearchParams({
    habitatId: params.habitatId,
    x: String(params.x),
    y: String(params.y),
    sensorStrength: String(params.sensorStrength),
    radiusTiles: String(params.radiusTiles),
  });

  return fetchKeplerJson(`/world/scan?${search.toString()}`, "habitat resource scan");
}

export async function refreshKeplerBlueprintCatalog(): Promise<KeplerBlueprintCatalogEntry[]> {
  return fetchKeplerBlueprintCatalog();
}
