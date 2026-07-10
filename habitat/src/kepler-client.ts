const keplerBaseUrl = "https://planet.turingguild.com";

export type KeplerHabitat = {
  id: string;
  habitatSlug: string;
  displayName: string;
  catalogVersion: string;
  status: string;
  lastSeenAt?: string | null;
};

type KeplerHabitatResponse = {
  habitat?: Partial<KeplerHabitat>;
};

export type KeplerBlueprintCatalogEntry = {
  id?: string;
  blueprintId: string;
  displayName: string;
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

function readKeplerToken(commandHint: string): string {
  const token = process.env.KEPLER_PLANET_TOKEN;

  if (!token) {
    throw new Error(`Set KEPLER_PLANET_TOKEN before running '${commandHint}'.`);
  }

  return token;
}

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
  };
}

function normalizeBlueprintCatalogEntry(
  value: Partial<KeplerBlueprintCatalogEntry> & { id?: string },
): KeplerBlueprintCatalogEntry {
  const blueprintId = value.blueprintId ?? value.id;

  if (typeof blueprintId !== "string" || blueprintId.length === 0) {
    throw new Error("Kepler returned a blueprint without a valid blueprintId.");
  }

  const displayName =
    typeof value.displayName === "string" && value.displayName.length > 0
      ? value.displayName
      : blueprintId;

  return {
    id: typeof value.id === "string" ? value.id : undefined,
    blueprintId,
    displayName,
    description: typeof value.description === "string" ? value.description : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    output: value.output,
    inputs: value.inputs,
    productionCost: value.productionCost,
    requiredFacility: value.requiredFacility,
    buildTicks: typeof value.buildTicks === "number" ? value.buildTicks : undefined,
    prerequisites: Array.isArray(value.prerequisites) ? value.prerequisites : undefined,
    unlocks: Array.isArray(value.unlocks) ? value.unlocks : undefined,
    repeatable: typeof value.repeatable === "boolean" ? value.repeatable : undefined,
    level: typeof value.level === "number" || value.level === null ? value.level : undefined,
    target: value.target,
    facilityLevel: value.facilityLevel,
    attachmentPoints: value.attachmentPoints,
    attachmentRequirements: Array.isArray(value.attachmentRequirements)
      ? value.attachmentRequirements
      : undefined,
    runtimeAttributes: value.runtimeAttributes,
    capabilities: Array.isArray(value.capabilities) ? value.capabilities : undefined,
  };
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
      return candidate.map((entry) =>
        normalizeBlueprintCatalogEntry(entry as Partial<KeplerBlueprintCatalogEntry> & { id?: string }),
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

export async function fetchKeplerBlueprintCatalog(): Promise<KeplerBlueprintCatalogEntry[]> {
  const token = readKeplerToken("habitat blueprint list");

  const response = await fetch(`${keplerBaseUrl}/catalog/blueprints`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Kepler blueprint catalog: ${response.status} ${response.statusText}.`,
    );
  }

  const payload = (await response.json()) as KeplerBlueprintCatalogResponse;
  return extractBlueprintEntries(payload);
}

export async function fetchKeplerResourceCatalog(): Promise<KeplerResourceCatalogEntry[]> {
  const token = readKeplerToken("habitat resource list");

  const response = await fetch(`${keplerBaseUrl}/catalog/resources`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Kepler resource catalog: ${response.status} ${response.statusText}.`,
    );
  }

  const payload = (await response.json()) as KeplerResourceCatalogResponse;
  return extractResourceEntries(payload);
}

export async function fetchKeplerSolarIrradiance(): Promise<number> {
  const token = readKeplerToken("habitat tick");

  const response = await fetch(`${keplerBaseUrl}/world/solar-irradiance`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Kepler solar irradiance: ${response.status} ${response.statusText}.`,
    );
  }

  const payload = (await response.json()) as KeplerSolarIrradianceResponse;
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

export async function fetchKeplerHabitatRegistration(
  habitatId: string,
): Promise<KeplerHabitat> {
  const token = readKeplerToken("habitat link --id <habitatId>");
  const response = await fetch(
    `${keplerBaseUrl}/habitats/${encodeURIComponent(habitatId)}/registration`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Kepler habitat '${habitatId}': ${response.status} ${response.statusText}.`,
    );
  }

  const payload = (await response.json()) as KeplerHabitatResponse;

  if (!payload.habitat || typeof payload.habitat !== "object") {
    throw new Error("Kepler habitat registration response did not include a habitat object.");
  }

  return normalizeKeplerHabitat(payload.habitat);
}
