import type { KeplerBlueprintCatalogEntry } from "../kepler/service";
import { canSpendInventory, spendInventoryMaterials } from "./inventory";
import type { HabitatModule } from "./modules";
import {
  BATTERY_MAX_CHARGE,
  applySolarChargeToBattery,
  chargerChargeRate,
  computeBatteryChargeAfterTick,
  batteryRemainingCapacity,
  moduleCurrentPowerDraw,
  moduleCurrentState,
  solarGeneratedChargePerTick,
  spendConstructionPower,
} from "./power";
import { createUniqueModuleName } from "./modules";

export type ConstructionJobDraft = {
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

export type ConstructionHabitatState = {
  modules: HabitatModule[];
  inventory: Record<string, number>;
  constructionJobs: Array<{ facilityModuleId: string }>;
  power: { powerConsumedTicks: number };
};

function moduleLevel(module: HabitatModule): number {
  const explicitLevel = module.runtimeAttributes.level ?? module.runtimeAttributes.blueprintLevel;
  return typeof explicitLevel === "number" && Number.isFinite(explicitLevel) ? explicitLevel : 1;
}

function moduleOutputType(module: HabitatModule): string | undefined {
  const moduleType = module.runtimeAttributes.moduleType;
  return typeof moduleType === "string" && moduleType.length > 0 ? moduleType : undefined;
}

function isModuleAvailable(module: HabitatModule): boolean {
  const state = module.runtimeAttributes.state ?? module.runtimeAttributes.status;
  return state === "online" || state === "idle" || state === "active";
}

function isBatteryModule(module: HabitatModule): boolean {
  const runtimeEnergyStorage = module.runtimeAttributes.energyStorageKwh;
  const outputType = moduleOutputType(module);

  return (
    module.runtimeAttributes.isBattery === true ||
    module.capabilities.includes("isBattery") ||
    module.blueprintId === "battery-bank" ||
    outputType === "battery-bank" ||
    (typeof runtimeEnergyStorage === "number" && Number.isFinite(runtimeEnergyStorage) && runtimeEnergyStorage > 0) ||
    module.blueprintId.toLowerCase().includes("battery") ||
    (typeof outputType === "string" && outputType.toLowerCase().includes("battery"))
  );
}

function isChargerModule(module: HabitatModule): boolean {
  return module.runtimeAttributes.isCharger === true || module.capabilities.includes("isCharger");
}

function hasLocalPrerequisite(state: ConstructionHabitatState, prerequisite: string): boolean {
  return state.modules.some(
    (module) =>
      module.blueprintId === prerequisite ||
      moduleOutputType(module) === prerequisite ||
      module.capabilities.includes(prerequisite),
  );
}

function hasUsablePower(state: ConstructionHabitatState): boolean {
  return state.modules.some((module) => {
    if (!isModuleAvailable(module)) {
      return false;
    }

    if (module.runtimeAttributes.isCharger === true || module.capabilities.includes("isCharger")) {
      return true;
    }

    if (isBatteryModule(module)) {
      const charge = module.runtimeAttributes.charge;
      return typeof charge === "number" && Number.isFinite(charge) ? charge > 0 : true;
    }

    return false;
  });
}

function normalizeMaterials(blueprint: KeplerBlueprintCatalogEntry): Record<string, number> {
  if (!blueprint.inputs || typeof blueprint.inputs !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(blueprint.inputs).filter(
      ([resourceId, amount]) =>
        typeof resourceId === "string" &&
        typeof amount === "number" &&
        Number.isFinite(amount) &&
        amount > 0,
    ),
  ) as Record<string, number>;
}

function facilityMatches(module: HabitatModule, requiredFacility: Record<string, unknown>, minimumLevel: number): boolean {
  const moduleType = requiredFacility.moduleType;
  if (typeof moduleType !== "string" || moduleType.length === 0) {
    return false;
  }

  return (
    (module.blueprintId === moduleType || moduleOutputType(module) === moduleType) &&
    isModuleAvailable(module) &&
    moduleLevel(module) >= minimumLevel
  );
}

function isFacilityBusy(state: ConstructionHabitatState, moduleId: string): boolean {
  return state.constructionJobs.some((job) => job.facilityModuleId === moduleId);
}

function validateBuildableBlueprint(blueprint: KeplerBlueprintCatalogEntry): void {
  if (blueprint.status !== "published") {
    throw new Error(`Blueprint '${blueprint.blueprintId}' must be published before construction can start.`);
  }

  if (!blueprint.output || typeof blueprint.output !== "object") {
    throw new Error(`Blueprint '${blueprint.blueprintId}' does not describe a buildable output.`);
  }

  const itemType = (blueprint.output as Record<string, unknown>).itemType;
  if (itemType !== "module") {
    throw new Error(`Blueprint '${blueprint.blueprintId}' does not describe something buildable.`);
  }

  if (typeof blueprint.buildTicks !== "number" || !Number.isFinite(blueprint.buildTicks) || blueprint.buildTicks <= 0) {
    throw new Error(`Blueprint '${blueprint.blueprintId}' does not define a valid build time.`);
  }
}

function chooseFacility(state: ConstructionHabitatState, blueprint: KeplerBlueprintCatalogEntry): HabitatModule {
  const requiredFacility = blueprint.requiredFacility;
  if (!requiredFacility || typeof requiredFacility !== "object") {
    throw new Error(`Blueprint '${blueprint.blueprintId}' does not define a required construction facility.`);
  }

  const minimumLevel =
    typeof requiredFacility.minimumLevel === "number" && Number.isFinite(requiredFacility.minimumLevel)
      ? requiredFacility.minimumLevel
      : 1;

  const facility = state.modules.find(
    (module) => facilityMatches(module, requiredFacility, minimumLevel) && !isFacilityBusy(state, module.id),
  );

  if (!facility) {
    throw new Error(`No required construction facility is online and available for '${blueprint.blueprintId}'.`);
  }

  return facility;
}

export function planConstructionStart(input: {
  blueprint: KeplerBlueprintCatalogEntry;
  habitat: ConstructionHabitatState;
  displayName?: string;
  moduleName?: string;
}): {
  blueprint: KeplerBlueprintCatalogEntry;
  name: string;
  moduleName: string;
  displayName: string;
  facility: HabitatModule;
  consumedMaterials: Record<string, number>;
  totalBuildTicks: number;
  runtimeAttributes: Record<string, unknown>;
  capabilities: string[];
} {
  validateBuildableBlueprint(input.blueprint);
  const totalBuildTicks = input.blueprint.buildTicks as number;

  if (Array.isArray(input.blueprint.prerequisites)) {
    const missingPrerequisite = input.blueprint.prerequisites.find(
      (prerequisite) => !hasLocalPrerequisite(input.habitat, prerequisite),
    );

    if (missingPrerequisite) {
      throw new Error(`Missing prerequisite '${missingPrerequisite}' for '${input.blueprint.blueprintId}'.`);
    }
  }

  const requiredMaterials = normalizeMaterials(input.blueprint);
  if (!canSpendInventory(input.habitat.inventory, requiredMaterials)) {
    throw new Error(`Local inventory does not contain the required materials for '${input.blueprint.blueprintId}'.`);
  }

  const supplyModuleExists = input.habitat.modules.some(
    (module) =>
      isModuleAvailable(module) &&
      (module.blueprintId === "supply-cache" ||
        moduleOutputType(module) === "supply-cache" ||
        module.capabilities.includes("logistics")),
  );

  if (!supplyModuleExists) {
    throw new Error("Construction requires an online supply cache or logistics module.");
  }

  if (!hasUsablePower(input.habitat)) {
    throw new Error("Construction requires usable habitat power.");
  }

  const facility = chooseFacility(input.habitat, input.blueprint);
  const displayName = input.displayName ?? input.blueprint.displayName ?? input.blueprint.blueprintId;
  const name = createUniqueModuleName(input.moduleName ?? displayName, input.habitat.modules.map((module) => module.name));

  return {
    blueprint: input.blueprint,
    name,
    moduleName: input.moduleName ?? displayName,
    displayName,
    facility,
    consumedMaterials: requiredMaterials,
    totalBuildTicks,
    runtimeAttributes: {
      ...(input.blueprint.runtimeAttributes ?? {}),
      ...(typeof input.blueprint.level === "number" && Number.isFinite(input.blueprint.level)
        ? { blueprintLevel: input.blueprint.level }
        : {}),
      ...(typeof input.blueprint.output?.level === "number" && Number.isFinite(input.blueprint.output.level)
        ? { level: input.blueprint.output.level }
        : {}),
      ...(typeof input.blueprint.output?.moduleType === "string" && input.blueprint.output.moduleType.length > 0
        ? { moduleType: input.blueprint.output.moduleType }
        : {}),
      ...(input.blueprint.runtimeAttributes?.isBattery === true || input.blueprint.capabilities?.includes("isBattery")
        ? { charge: 100 }
        : {}),
    },
    capabilities: [...(input.blueprint.capabilities ?? [])],
  };
}

export function previewConstructionStart(input: {
  blueprint: KeplerBlueprintCatalogEntry;
  habitat: ConstructionHabitatState;
  displayName?: string;
  moduleName?: string;
}): {
  requiredFacilityExists: boolean;
  fabricatorAvailable: boolean;
  supplyCacheOnline: boolean;
  prerequisitesMet: boolean;
  inventoryHasMaterials: boolean;
  moduleToBeCreated: string;
  resourcesToBeSpent: Record<string, number>;
  canStart: boolean;
} {
  validateBuildableBlueprint(input.blueprint);
  const requiredFacility = input.blueprint.requiredFacility;
  const minimumLevel =
    requiredFacility && typeof requiredFacility === "object" &&
    typeof requiredFacility.minimumLevel === "number" &&
    Number.isFinite(requiredFacility.minimumLevel)
      ? requiredFacility.minimumLevel
      : 1;
  const facilityExists =
    !!requiredFacility &&
    typeof requiredFacility === "object" &&
    input.habitat.modules.some((module) => facilityMatches(module, requiredFacility as Record<string, unknown>, minimumLevel));
  const fabricatorAvailable =
    !!requiredFacility &&
    typeof requiredFacility === "object" &&
    input.habitat.modules.some(
      (module) =>
        facilityMatches(module, requiredFacility as Record<string, unknown>, minimumLevel) &&
        !isFacilityBusy(input.habitat, module.id),
    );
  const supplyCacheOnline = input.habitat.modules.some(
    (module) =>
      isModuleAvailable(module) &&
      (module.blueprintId === "supply-cache" ||
        moduleOutputType(module) === "supply-cache" ||
        module.capabilities.includes("logistics")),
  );
  const prerequisitesMet = !Array.isArray(input.blueprint.prerequisites)
    ? true
    : !input.blueprint.prerequisites.find(
        (prerequisite) => !hasLocalPrerequisite(input.habitat, prerequisite),
      );
  const resourcesToBeSpent = normalizeMaterials(input.blueprint);
  const inventoryHasMaterials = canSpendInventory(input.habitat.inventory, resourcesToBeSpent);
  const moduleToBeCreated = input.moduleName ?? input.blueprint.displayName ?? input.blueprint.blueprintId;
  const canStart =
    facilityExists &&
    fabricatorAvailable &&
    supplyCacheOnline &&
    prerequisitesMet &&
    inventoryHasMaterials &&
    hasUsablePower(input.habitat);

  return {
    requiredFacilityExists: facilityExists,
    fabricatorAvailable,
    supplyCacheOnline,
    prerequisitesMet,
    inventoryHasMaterials,
    moduleToBeCreated,
    resourcesToBeSpent,
    canStart,
  };
}

export function forceConstructionStart(input: {
  blueprint: KeplerBlueprintCatalogEntry;
  habitat: ConstructionHabitatState;
  displayName?: string;
  moduleName?: string;
}): {
  name: string;
  moduleName: string;
  displayName: string;
  blueprintId: string;
  facilityModuleId: string;
  facilityModuleName: string;
  consumedMaterials: Record<string, number>;
  runtimeAttributes: Record<string, unknown>;
  capabilities: string[];
  totalBuildTicks: number;
} {
  validateBuildableBlueprint(input.blueprint);
  const totalBuildTicks = input.blueprint.buildTicks as number;
  const requiredMaterials = normalizeMaterials(input.blueprint);
  const facility =
    input.habitat.modules.find((module) => isModuleAvailable(module)) ??
    ({
      id: "debug-forced-facility",
      name: "debug-forced-facility",
      blueprintId: "debug-forced-facility",
      displayName: "Debug Forced Facility",
      connectedTo: [],
      runtimeAttributes: { state: "online" },
      capabilities: [],
    } as HabitatModule);
  const displayName = input.displayName ?? input.blueprint.displayName ?? input.blueprint.blueprintId;

  return {
    name: createUniqueModuleName(input.moduleName ?? displayName, input.habitat.modules.map((module) => module.name)),
    moduleName: input.moduleName ?? displayName,
    displayName,
    blueprintId: input.blueprint.blueprintId,
    facilityModuleId: facility.id,
    facilityModuleName: facility.displayName,
    consumedMaterials: requiredMaterials,
    runtimeAttributes: {
      ...(input.blueprint.runtimeAttributes ?? {}),
      ...(typeof input.blueprint.level === "number" && Number.isFinite(input.blueprint.level)
        ? { blueprintLevel: input.blueprint.level }
        : {}),
      ...(typeof input.blueprint.output?.level === "number" && Number.isFinite(input.blueprint.output.level)
        ? { level: input.blueprint.output.level }
        : {}),
      ...(typeof input.blueprint.output?.moduleType === "string" && input.blueprint.output.moduleType.length > 0
        ? { moduleType: input.blueprint.output.moduleType }
        : {}),
      ...(input.blueprint.runtimeAttributes?.isBattery === true || input.blueprint.capabilities?.includes("isBattery")
        ? { charge: 100 }
        : {}),
      state: "online",
      status: "online",
    },
    capabilities: [...(input.blueprint.capabilities ?? [])],
    totalBuildTicks,
  };
}

export function createModuleFromConstructionJob(
  job: {
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
  },
  existingModules: HabitatModule[],
): HabitatModule {
  const module = {
    id: job.moduleName,
    name: job.moduleName,
    blueprintId: job.blueprintId,
    displayName: job.moduleName,
    connectedTo: [],
    runtimeAttributes: {
      ...job.runtimeAttributes,
      state: "online",
      status: "online",
      charge:
        typeof job.runtimeAttributes.charge === "number" && Number.isFinite(job.runtimeAttributes.charge)
          ? job.runtimeAttributes.charge
          : undefined,
    },
    capabilities: [...job.capabilities],
  };

  return module;
}

export function advanceConstructionTick(
  state: ConstructionHabitatState,
  irradiance: number,
): {
  energyCost: number;
  advancedConstructionTicks: number;
  pausedConstructionTicks: number;
  completedJobs: string[];
  state: ConstructionHabitatState;
} {
  const completedJobs: string[] = [];
  let advancedConstructionTicks = 0;
  let pausedConstructionTicks = 0;
  let energyCost = 0;
  const totalPowerDraw = state.modules.reduce((total, module) => total + moduleCurrentPowerDraw(module), 0);
  energyCost += totalPowerDraw;
  state.power.powerConsumedTicks += totalPowerDraw;

  const batteries = state.modules.filter((module) => isBatteryModule(module));
  const onlineConsumers = state.modules.filter(
    (module) => moduleCurrentState(module) === "online" && !isBatteryModule(module) && !isChargerModule(module),
  );
  const onlineChargers = state.modules.filter(
    (module) => moduleCurrentState(module) === "online" && isChargerModule(module),
  );
  const totalDrain = onlineConsumers.length;
  const totalCharge = onlineChargers.reduce((total, module) => total + chargerChargeRate(module, irradiance), 0);
  const drainPerBattery = batteries.length > 0 ? totalDrain / batteries.length : 0;
  const chargePerBattery = batteries.length > 0 ? totalCharge / batteries.length : 0;
  const generatedCharge = onlineChargers.reduce(
    (total, module) => total + solarGeneratedChargePerTick(module, irradiance),
    0,
  );
  const totalRemainingCapacity = batteries.reduce((total, module) => total + batteryRemainingCapacity(module), 0);

  for (const module of state.modules) {
    const currentPowerTicks = module.runtimeAttributes.powerConsumedTicks;
    const modulePowerDraw = moduleCurrentPowerDraw(module);
    const nextPowerTicks =
      typeof currentPowerTicks === "number" && Number.isFinite(currentPowerTicks)
        ? currentPowerTicks + modulePowerDraw
        : modulePowerDraw;

    module.runtimeAttributes = {
      ...module.runtimeAttributes,
      powerConsumedTicks: nextPowerTicks,
    };
  }

  for (const module of batteries) {
    const remainingCapacity = batteryRemainingCapacity(module);
    const batteryShare =
      totalRemainingCapacity > 0 ? generatedCharge * (remainingCapacity / totalRemainingCapacity) : 0;
    const nextCharge = computeBatteryChargeAfterTick(module, chargePerBattery, drainPerBattery);
    const nextSolarCharge = applySolarChargeToBattery(
      { ...module, runtimeAttributes: { ...module.runtimeAttributes, currentEnergyKwh: nextCharge, charge: nextCharge } },
      batteryShare,
    );
    module.runtimeAttributes = {
      ...module.runtimeAttributes,
      currentEnergyKwh: nextSolarCharge,
      charge: nextSolarCharge,
    };
  }

  if (state.constructionJobs.length === 0) {
    return { energyCost, advancedConstructionTicks, pausedConstructionTicks, completedJobs, state };
  }

  const nextJobs: Array<any> = [];
  for (const job of state.constructionJobs as Array<any>) {
    const facility = state.modules.find((module) => module.id === job.facilityModuleId);
    const constructionPower = spendConstructionPower(state, 1);
    if (!facility || !isModuleAvailable(facility) || !constructionPower.spent) {
      pausedConstructionTicks += 1;
      nextJobs.push(job);
      continue;
    }

    const remainingBuildTicks = job.remainingBuildTicks - 1;
    advancedConstructionTicks += 1;
    if (remainingBuildTicks <= 0) {
      state.modules.push(createModuleFromConstructionJob(job, state.modules));
      completedJobs.push(job.moduleName);
      continue;
    }
    nextJobs.push({ ...job, remainingBuildTicks });
  }
  state.constructionJobs = nextJobs;
  return { energyCost, advancedConstructionTicks, pausedConstructionTicks, completedJobs, state };
}
