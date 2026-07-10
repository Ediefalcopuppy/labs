import type { KeplerBlueprintCatalogEntry } from "./kepler/service";

export type ConstructionModule = {
  id: string;
  name: string;
  blueprintId: string;
  displayName: string;
  connectedTo: string[];
  runtimeAttributes: Record<string, unknown>;
  capabilities: string[];
};

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
  modules: ConstructionModule[];
  inventory: Record<string, number>;
  constructionJobs: Array<{ facilityModuleId: string }>;
  power: { powerConsumedTicks: number };
};

export type ConstructionPlan = {
  blueprint: KeplerBlueprintCatalogEntry;
  name: string;
  moduleName: string;
  displayName: string;
  facility: ConstructionModule;
  consumedMaterials: Record<string, number>;
  totalBuildTicks: number;
  runtimeAttributes: Record<string, unknown>;
  capabilities: string[];
};

export type ConstructionDryRunReport = {
  requiredFacilityExists: boolean;
  fabricatorAvailable: boolean;
  supplyCacheOnline: boolean;
  prerequisitesMet: boolean;
  inventoryHasMaterials: boolean;
  moduleToBeCreated: string;
  resourcesToBeSpent: Record<string, number>;
  canStart: boolean;
};

export type ConstructionPowerSpendResult = {
  spent: boolean;
  remainingChargeByModuleId: Record<string, number>;
};

export const BATTERY_MAX_CHARGE = 10000;

export function batteryConstructionDrainPerTick(module: ConstructionModule): number {
  const capacityMultiplier = moduleChargeLossMultiplier(module);
  return 1 / (100 * capacityMultiplier);
}

export function batteryRemainingCapacity(module: ConstructionModule): number {
  return Math.max(0, batteryStorageCapacity(module) - batteryCharge(module));
}

export function solarGeneratedChargePerTick(
  module: ConstructionModule,
  irradiance: number,
): number {
  const powerGenerationKw = (() => {
    const fromGeneration = module.runtimeAttributes.powerGenerationKw;
    if (typeof fromGeneration === "number" && Number.isFinite(fromGeneration)) {
      return fromGeneration;
    }

    const fromPower = module.runtimeAttributes.powerOutputKw;
    if (typeof fromPower === "number" && Number.isFinite(fromPower)) {
      return fromPower;
    }

    const fromRuntime = module.runtimeAttributes.generationKw;
    if (typeof fromRuntime === "number" && Number.isFinite(fromRuntime)) {
      return fromRuntime;
    }

    return 0;
  })();

  if (powerGenerationKw <= 0) {
    return 0;
  }

  const solarMultiplier = irradiance / 900;
  const solarEfficiency = 0.5;

  return (powerGenerationKw * solarMultiplier * solarEfficiency) / 3600;
}

export function applySolarChargeToBattery(
  module: ConstructionModule,
  generatedKwhPerTick: number,
): number {
  const currentEnergy = batteryCharge(module);
  return Math.min(batteryStorageCapacity(module), currentEnergy + Math.max(0, generatedKwhPerTick));
}

export function solarChargePerTick(module: ConstructionModule, irradiance: number): number {
  if (!module.capabilities.includes("isCharger") && module.runtimeAttributes.isCharger !== true) {
    return 0;
  }

  const baseRate = (() => {
    const runtimeRate = module.runtimeAttributes.chargePerTick;
    if (typeof runtimeRate === "number" && Number.isFinite(runtimeRate)) {
      return runtimeRate;
    }

    return 1;
  })();

  const upgradeLevelValue = module.runtimeAttributes.blueprintLevel ?? module.runtimeAttributes.level;
  const upgradeLevel =
    typeof upgradeLevelValue === "number" && Number.isFinite(upgradeLevelValue)
      ? upgradeLevelValue
      : 0;

  return baseRate * irradiance * Math.pow(1.5, upgradeLevel);
}

export function computeBatteryChargeAfterTick(
  module: ConstructionModule,
  chargePerBattery: number,
  drainPerBattery: number,
): number {
  const currentCharge = batteryCharge(module);
  const selfDischarge = batteryConstructionDrainPerTick(module);
  const nextCharge = currentCharge +
    (chargePerBattery - drainPerBattery * moduleChargeLossMultiplier(module)) -
    selfDischarge;

  return Math.max(
    0,
    Math.min(batteryStorageCapacity(module), nextCharge),
  );
}

export type ForcedModuleBuild = {
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
};

function isModuleAvailable(module: ConstructionModule): boolean {
  const state = module.runtimeAttributes.state ?? module.runtimeAttributes.status;
  return state === "online" || state === "idle" || state === "active";
}

function isBatteryModule(module: ConstructionModule): boolean {
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

function batteryCharge(module: ConstructionModule): number {
  const currentEnergy = module.runtimeAttributes.currentEnergyKwh;
  if (typeof currentEnergy === "number" && Number.isFinite(currentEnergy)) {
    return currentEnergy;
  }

  const charge = module.runtimeAttributes.charge;
  return typeof charge === "number" && Number.isFinite(charge) ? charge : batteryStorageCapacity(module);
}

function batteryStorageCapacity(module: ConstructionModule): number {
  const storage = module.runtimeAttributes.energyStorageKwh;
  if (typeof storage === "number" && Number.isFinite(storage) && storage > 0) {
    return storage;
  }

  return BATTERY_MAX_CHARGE;
}

function moduleChargeLossMultiplier(module: ConstructionModule): number {
  const fromModule = module.runtimeAttributes.chargeLossPerTickMult;
  if (typeof fromModule === "number" && Number.isFinite(fromModule)) {
    return Math.min(1, Math.max(0.01, fromModule));
  }

  return 1;
}

export function createUniqueModuleName(
  displayName: string,
  existingNames: string[],
): string {
  const baseName = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const normalizedBase = baseName.length > 0 ? baseName : "module";
  let suffix = 1;

  while (existingNames.includes(`${normalizedBase}-${suffix}`)) {
    suffix += 1;
  }

  return `${normalizedBase}-${suffix}`;
}

export function normalizeModuleNames<T extends ConstructionModule>(modules: T[]): T[] {
  const usedNames = new Set(
    modules
      .map((module) => (typeof module.name === "string" ? module.name.trim().toLowerCase() : ""))
      .filter((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/.test(name)),
  );

  return modules.map((module) => {
    const sourceName =
      typeof module.name === "string" && module.name.trim().length > 0
        ? module.name
        : typeof module.displayName === "string" && module.displayName.trim().length > 0
          ? module.displayName
          : module.blueprintId || module.id;
    const normalizedName = sourceName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "module";
    const suffixMatch = normalizedName.match(/^(.*)-(\d+)$/);
    const baseName = suffixMatch?.[1] || normalizedName;
    const currentNameIsAvailable = suffixMatch !== null && usedNames.has(normalizedName);
    if (currentNameIsAvailable) {
      usedNames.delete(normalizedName);
    }
    const name = currentNameIsAvailable
      ? normalizedName
      : createUniqueModuleName(baseName, [...usedNames]);

    usedNames.add(name);
    return { ...module, name };
  });
}

export function spendConstructionPower(
  state: ConstructionHabitatState,
  amount: number,
): ConstructionPowerSpendResult {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { spent: true, remainingChargeByModuleId: {} };
  }

  const batteries = state.modules.filter(
    (module) => isModuleAvailable(module) && isBatteryModule(module),
  );

  if (batteries.length === 0) {
    return { spent: false, remainingChargeByModuleId: {} };
  }

  const totalCharge = batteries.reduce((sum, module) => {
    const currentCharge = module.runtimeAttributes.charge;
    const normalizedCharge =
      typeof currentCharge === "number" && Number.isFinite(currentCharge) ? currentCharge : BATTERY_MAX_CHARGE;
    return sum + Math.max(0, normalizedCharge);
  }, 0);

  if (totalCharge < amount) {
    return { spent: false, remainingChargeByModuleId: {} };
  }

  const nextChargeByModuleId: Record<string, number> = {};
  const drawPerBattery = amount / batteries.length;

  for (const module of batteries) {
    const capacityMultiplier = moduleChargeLossMultiplier(module);
    const currentCharge = module.runtimeAttributes.charge;
    const normalizedCharge =
      typeof currentCharge === "number" && Number.isFinite(currentCharge)
        ? currentCharge
        : batteryStorageCapacity(module);
    const scaledConstructionDrain = drawPerBattery / (100 * capacityMultiplier);
    const nextCharge = Math.max(0, normalizedCharge - scaledConstructionDrain);

    nextChargeByModuleId[module.id] = nextCharge;
  }

  for (const module of batteries) {
    module.runtimeAttributes = {
      ...module.runtimeAttributes,
      charge: nextChargeByModuleId[module.id] ?? 0,
    };
  }

  return { spent: true, remainingChargeByModuleId: nextChargeByModuleId };
}

function moduleLevel(module: ConstructionModule): number {
  const explicitLevel = module.runtimeAttributes.level ?? module.runtimeAttributes.blueprintLevel;
  return typeof explicitLevel === "number" && Number.isFinite(explicitLevel) ? explicitLevel : 1;
}

function moduleOutputType(module: ConstructionModule): string | undefined {
  const moduleType = module.runtimeAttributes.moduleType;
  return typeof moduleType === "string" && moduleType.length > 0 ? moduleType : undefined;
}

function isFacilityBusy(state: ConstructionHabitatState, moduleId: string): boolean {
  return state.constructionJobs.some((job) => job.facilityModuleId === moduleId);
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

function hasMaterials(
  inventory: Record<string, number>,
  requiredMaterials: Record<string, number>,
): boolean {
  return Object.entries(requiredMaterials).every(
    ([resourceId, amount]) => (inventory[resourceId] ?? 0) >= amount,
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

function facilityMatches(
  module: ConstructionModule,
  requiredFacility: Record<string, unknown>,
  minimumLevel: number,
): boolean {
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

function hasLocalPrerequisite(state: ConstructionHabitatState, prerequisite: string): boolean {
  return state.modules.some(
    (module) =>
      module.blueprintId === prerequisite ||
      moduleOutputType(module) === prerequisite ||
      module.capabilities.includes(prerequisite),
  );
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

function chooseFacility(
  state: ConstructionHabitatState,
  blueprint: KeplerBlueprintCatalogEntry,
): ConstructionModule {
  const requiredFacility = blueprint.requiredFacility;
  if (!requiredFacility || typeof requiredFacility !== "object") {
    throw new Error(`Blueprint '${blueprint.blueprintId}' does not define a required construction facility.`);
  }

  const minimumLevel =
    typeof requiredFacility.minimumLevel === "number" && Number.isFinite(requiredFacility.minimumLevel)
      ? requiredFacility.minimumLevel
      : 1;

  const facility = state.modules.find(
    (module) =>
      facilityMatches(module, requiredFacility, minimumLevel) &&
      !isFacilityBusy(state, module.id),
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
}): ConstructionPlan {
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
  if (!hasMaterials(input.habitat.inventory, requiredMaterials)) {
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
  const displayName =
    input.displayName ?? input.blueprint.displayName ?? input.blueprint.blueprintId;
  const name = createUniqueModuleName(
    input.moduleName ?? displayName,
    input.habitat.modules.map((module) => module.name),
  );

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
      ...(typeof input.blueprint.output?.moduleType === "string" &&
      input.blueprint.output.moduleType.length > 0
        ? { moduleType: input.blueprint.output.moduleType }
        : {}),
      ...(input.blueprint.runtimeAttributes?.isBattery === true ||
      input.blueprint.capabilities?.includes("isBattery")
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
}): ConstructionDryRunReport {
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
    input.habitat.modules.some((module) => {
      if (!facilityMatches(module, requiredFacility as Record<string, unknown>, minimumLevel)) {
        return false;
      }

      return true;
    });
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
  const inventoryHasMaterials = hasMaterials(input.habitat.inventory, resourcesToBeSpent);
  const moduleToBeCreated =
    input.moduleName ?? input.blueprint.displayName ?? input.blueprint.blueprintId;
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
}): ForcedModuleBuild {
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
    } as ConstructionModule);
  const displayName =
    input.displayName ?? input.blueprint.displayName ?? input.blueprint.blueprintId;

  return {
    name: createUniqueModuleName(
      input.moduleName ?? displayName,
      input.habitat.modules.map((module) => module.name),
    ),
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
      ...(typeof input.blueprint.output?.moduleType === "string" &&
      input.blueprint.output.moduleType.length > 0
        ? { moduleType: input.blueprint.output.moduleType }
        : {}),
      ...(input.blueprint.runtimeAttributes?.isBattery === true ||
      input.blueprint.capabilities?.includes("isBattery")
        ? { charge: 100 }
        : {}),
      state: "online",
      status: "online",
    },
    capabilities: [...(input.blueprint.capabilities ?? [])],
    totalBuildTicks,
  };
}
