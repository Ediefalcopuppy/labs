export type HabitatInventory = Record<string, number>;

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
  habitatSlug?: string;
  catalogVersion?: string;
  remoteStatus?: string;
  lastSeenAt?: string | null;
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
  registration?: HabitatRegistration;
};

export type PartialHabitatState = Partial<HabitatState>;
import type { KeplerBlueprintCatalogEntry } from "../kepler/service";
