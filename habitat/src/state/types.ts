export type HabitatInventory = Record<string, number>;

export type HabitatHuman = {
  id: string;
  name?: string;
  moduleId?: string;
  x?: number;
  y?: number;
  status?: string;
  [key: string]: unknown;
};

export type EvaState = {
  deployed: boolean;
  humanId?: string;
  x: number;
  y: number;
  carriedResources: HabitatInventory;
  maxCarryingCapacityKg: number;
};

export type HabitatAlert = {
  id: string;
  status: "open" | "acknowledged" | string;
  message?: string;
  severity?: string;
  [key: string]: unknown;
};

export type HabitatPowerTick = {
  powerConsumedTicks: number;
};

export type StarterModuleInstance = {
  id: string;
  name: string;
  blueprintId: string;
  displayName: string;
  connectedTo: string[];
  runtimeAttributes: Record<string, unknown>;
  capabilities: string[];
};

export type StarterModuleRegistration = {
  id: string;
  blueprintId: string;
  displayName: string;
  connectedTo: string[];
  runtimeAttributes: Record<string, unknown>;
  capabilities: string[];
};

export type StarterHuman = {
  id: string;
  displayName: string;
  locationModuleId: string;
};

export type AlertContract = {
  schemaVersion: string;
  schema: Record<string, unknown>;
};

export type RegistrationContracts = {
  alerts: AlertContract;
};

export type ConstructionJob = {
  id: string;
  moduleName: string;
  blueprintId: string;
  facilityModuleId: string;
  facilityModuleName: string;
  totalBuildTicks: number;
  remainingBuildTicks: number;
  consumedMaterials: Record<string, number>;
  runtimeAttributes: Record<string, unknown>;
  capabilities: string[];
};

export type Zone = {
  name: string;
  purpose: string;
  status: string;
};

export type Airlock = {
  name: string;
  pressureLevel: number;
  locked: boolean;
};

export type Door = {
  name: string;
  airlockName?: string;
};

export type HabitatRegistration = {
  displayName: string;
  registeredAt: string;
  lastSyncedAt: string;
  habitatId?: string;
  habitatUuid?: string;
  streamUrl?: string;
  stream?: RegistrationStream;
  habitatSlug?: string;
  catalogVersion?: string;
  remoteStatus?: string;
  lastSeenAt?: string | null;
  /** Kepler-owned registration fields supplied by the live registration response. */
  starterHumans?: StarterHuman[];
  starterModules?: StarterModuleRegistration[];
  contracts?: RegistrationContracts;
  contacts?: unknown;
};

export type HabitatState = {
  zones: Zone[];
  airlocks: Airlock[];
  doors: Door[];
  modules: StarterModuleInstance[];
  blueprints: KeplerBlueprintCatalogEntry[];
  inventory: HabitatInventory;
  constructionJobs: ConstructionJob[];
  power: HabitatPowerTick;
  humans: HabitatHuman[];
  eva: EvaState;
  alerts: HabitatAlert[];
  registration?: HabitatRegistration;
};

export type PartialHabitatState = Partial<HabitatState>;
import type { KeplerBlueprintCatalogEntry } from "../kepler/service";
import type { RegistrationStream } from "../clock/types";
