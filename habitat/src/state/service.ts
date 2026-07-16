import { readStateFromStorage, writeStateToStorage } from "./storage";
import type {
  Airlock,
  ConstructionJob,
  Door,
  HabitatInventory,
  HabitatPowerTick,
  HabitatRegistration,
  HabitatState,
  HabitatAlert,
  HabitatHuman,
  EvaState,
  PartialHabitatState,
  StarterModuleInstance,
  Zone,
} from "./types";

type StateServiceOptions = {
  storagePath: string;
};

const EMPTY_POWER: HabitatPowerTick = { powerConsumedTicks: 0 };
const EMPTY_EVA: EvaState = { deployed: false, x: 0, y: 0, carriedResources: {}, maxCarryingCapacityKg: 20 };

export function createEmptyState(): HabitatState {
  return {
    zones: [],
    airlocks: [],
    doors: [],
    modules: [],
    blueprints: [],
    inventory: {},
    constructionJobs: [],
    power: { ...EMPTY_POWER },
    humans: [],
    eva: { ...EMPTY_EVA, carriedResources: {} },
    alerts: [],
  };
}

function normalizeInventory(inventory: unknown): HabitatInventory {
  if (!inventory || typeof inventory !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(inventory).filter(
      ([key, value]) =>
        typeof key === "string" &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0,
    ),
  );
}

function normalizeRegistration(registration: unknown): HabitatRegistration | undefined {
  if (!registration || typeof registration !== "object") {
    return undefined;
  }

  const candidate = registration as Partial<HabitatRegistration>;
  return {
    displayName:
      typeof candidate.displayName === "string" && candidate.displayName.length > 0
        ? candidate.displayName
        : "Unnamed Habitat",
    registeredAt:
      typeof candidate.registeredAt === "string" && candidate.registeredAt.length > 0
        ? candidate.registeredAt
        : new Date(0).toISOString(),
    lastSyncedAt:
      typeof candidate.lastSyncedAt === "string" && candidate.lastSyncedAt.length > 0
        ? candidate.lastSyncedAt
        : typeof candidate.registeredAt === "string" && candidate.registeredAt.length > 0
          ? candidate.registeredAt
          : new Date(0).toISOString(),
    habitatId:
      typeof candidate.habitatId === "string" && candidate.habitatId.length > 0
        ? candidate.habitatId
        : undefined,
    habitatSlug:
      typeof candidate.habitatSlug === "string" && candidate.habitatSlug.length > 0
        ? candidate.habitatSlug
        : undefined,
    catalogVersion:
      typeof candidate.catalogVersion === "string" && candidate.catalogVersion.length > 0
        ? candidate.catalogVersion
        : undefined,
    remoteStatus:
      typeof candidate.remoteStatus === "string" && candidate.remoteStatus.length > 0
        ? candidate.remoteStatus
        : undefined,
    lastSeenAt:
      typeof candidate.lastSeenAt === "string" || candidate.lastSeenAt === null
        ? candidate.lastSeenAt
        : undefined,
    starterHumans: candidate.starterHumans,
    starterModules: candidate.starterModules,
    contracts: candidate.contracts,
    contacts: candidate.contacts,
  };
}

function normalizeHumans(humans: unknown): HabitatHuman[] {
  if (!Array.isArray(humans)) return [];
  return humans.filter((human): human is HabitatHuman => {
    const id = human && typeof human === "object" ? (human as Record<string, unknown>).id : undefined;
    return Boolean(
      human &&
        typeof human === "object" &&
        typeof id === "string" &&
        id.length > 0,
    );
  });
}

function normalizeEva(eva: unknown): EvaState {
  if (!eva || typeof eva !== "object") return { ...EMPTY_EVA, carriedResources: {} };
  const candidate = eva as Partial<EvaState>;
  return {
    deployed: typeof candidate.deployed === "boolean" ? candidate.deployed : false,
    humanId: typeof candidate.humanId === "string" && candidate.humanId.length > 0 ? candidate.humanId : undefined,
    x: typeof candidate.x === "number" && Number.isInteger(candidate.x) ? candidate.x : 0,
    y: typeof candidate.y === "number" && Number.isInteger(candidate.y) ? candidate.y : 0,
    carriedResources: normalizeInventory(candidate.carriedResources),
    maxCarryingCapacityKg: typeof candidate.maxCarryingCapacityKg === "number" && candidate.maxCarryingCapacityKg > 0 ? candidate.maxCarryingCapacityKg : 20,
  };
}

function normalizeAlerts(alerts: unknown): HabitatAlert[] {
  if (!Array.isArray(alerts)) return [];
  return alerts.filter((alert): alert is HabitatAlert => {
    if (!alert || typeof alert !== "object") return false;
    const candidate = alert as Record<string, unknown>;
    return typeof candidate.id === "string" && candidate.id.length > 0 && typeof candidate.status === "string";
  });
}

export function normalizeState(state: unknown): HabitatState {
  if (state === null || typeof state !== "object") {
    return createEmptyState();
  }

  const candidate = state as PartialHabitatState;
  return {
    zones: Array.isArray(candidate.zones) ? (candidate.zones as Zone[]) : [],
    airlocks: Array.isArray(candidate.airlocks) ? (candidate.airlocks as Airlock[]) : [],
    doors: Array.isArray(candidate.doors) ? (candidate.doors as Door[]) : [],
    modules: Array.isArray(candidate.modules) ? (candidate.modules as StarterModuleInstance[]) : [],
    blueprints: Array.isArray(candidate.blueprints) ? candidate.blueprints : [],
    inventory: normalizeInventory(candidate.inventory),
    constructionJobs: Array.isArray(candidate.constructionJobs)
      ? (candidate.constructionJobs as ConstructionJob[])
      : [],
    power:
      candidate.power && typeof candidate.power === "object"
        ? {
            powerConsumedTicks:
              typeof candidate.power.powerConsumedTicks === "number" &&
              Number.isFinite(candidate.power.powerConsumedTicks)
                ? candidate.power.powerConsumedTicks
                : 0,
          }
        : { ...EMPTY_POWER },
    humans: normalizeHumans(candidate.humans),
    eva: normalizeEva(candidate.eva),
    alerts: normalizeAlerts(candidate.alerts),
    registration: normalizeRegistration(candidate.registration),
  };
}

export function createStateService(options: StateServiceOptions) {
  return {
    async getState(): Promise<HabitatState> {
      const stored = await readStateFromStorage(options.storagePath);
      return normalizeState(stored ?? createEmptyState());
    },

    async saveState(state: HabitatState): Promise<HabitatState> {
      const normalized = normalizeState(state);
      await writeStateToStorage(options.storagePath, normalized);
      return normalized;
    },

    async resetState(): Promise<HabitatState> {
      const emptyState = createEmptyState();
      await writeStateToStorage(options.storagePath, emptyState);
      return emptyState;
    },
  };
}

export type StateService = ReturnType<typeof createStateService>;
