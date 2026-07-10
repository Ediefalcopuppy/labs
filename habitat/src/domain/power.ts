import type { HabitatModule } from "./modules";

export const BATTERY_MAX_CHARGE = 10000;

function batteryStorageCapacity(module: HabitatModule): number {
  const storage = module.runtimeAttributes.energyStorageKwh;
  if (typeof storage === "number" && Number.isFinite(storage) && storage > 0) {
    return storage;
  }

  return BATTERY_MAX_CHARGE;
}

function batteryCharge(module: HabitatModule): number {
  const currentEnergy = module.runtimeAttributes.currentEnergyKwh;
  if (typeof currentEnergy === "number" && Number.isFinite(currentEnergy)) {
    return currentEnergy;
  }

  const charge = module.runtimeAttributes.charge;
  return typeof charge === "number" && Number.isFinite(charge) ? charge : batteryStorageCapacity(module);
}

function moduleChargeLossMultiplier(module: HabitatModule): number {
  const fromModule = module.runtimeAttributes.chargeLossPerTickMult;
  if (typeof fromModule === "number" && Number.isFinite(fromModule)) {
    return Math.min(1, Math.max(0.01, fromModule));
  }

  return 1;
}

function isModuleAvailable(module: HabitatModule): boolean {
  const state = module.runtimeAttributes.state ?? module.runtimeAttributes.status;
  return state === "online" || state === "idle" || state === "active";
}

function isModuleState(value: unknown): value is "online" | "offline" | "idle" | "active" | "damaged" {
  return value === "online" || value === "offline" || value === "idle" || value === "active" || value === "damaged";
}

export function moduleCurrentState(module: HabitatModule): "online" | "offline" | "idle" | "active" | "damaged" {
  const candidate = module.runtimeAttributes.state ?? module.runtimeAttributes.status;
  return isModuleState(candidate) ? candidate : "offline";
}

export function moduleCurrentPowerDraw(module: HabitatModule): number {
  const state = moduleCurrentState(module);
  const byState = module.runtimeAttributes.powerDrawByState;

  if (byState && typeof byState === "object") {
    const candidate = (byState as Record<string, unknown>)[state];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  const stateSpecificKey = `${state}PowerDraw`;
  const stateSpecific = module.runtimeAttributes[stateSpecificKey];
  if (typeof stateSpecific === "number" && Number.isFinite(stateSpecific)) {
    return stateSpecific;
  }

  const draw = module.runtimeAttributes.powerDraw;
  if (typeof draw === "number" && Number.isFinite(draw)) {
    return draw;
  }

  return 0;
}

function isBatteryModule(module: HabitatModule): boolean {
  const runtimeEnergyStorage = module.runtimeAttributes.energyStorageKwh;
  const outputType = module.runtimeAttributes.moduleType;

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

export function batteryConstructionDrainPerTick(module: HabitatModule): number {
  const capacityMultiplier = moduleChargeLossMultiplier(module);
  return 1 / (100 * capacityMultiplier);
}

export function batteryRemainingCapacity(module: HabitatModule): number {
  return Math.max(0, batteryStorageCapacity(module) - batteryCharge(module));
}

export function solarGeneratedChargePerTick(module: HabitatModule, irradiance: number): number {
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

export function applySolarChargeToBattery(module: HabitatModule, generatedKwhPerTick: number): number {
  const currentEnergy = batteryCharge(module);
  return Math.min(batteryStorageCapacity(module), currentEnergy + Math.max(0, generatedKwhPerTick));
}

export function computeBatteryChargeAfterTick(
  module: HabitatModule,
  chargePerBattery: number,
  drainPerBattery: number,
): number {
  const currentCharge = batteryCharge(module);
  const selfDischarge = batteryConstructionDrainPerTick(module);
  const nextCharge =
    currentCharge + (chargePerBattery - drainPerBattery * moduleChargeLossMultiplier(module)) - selfDischarge;

  return Math.max(0, Math.min(batteryStorageCapacity(module), nextCharge));
}

export function chargerChargeRate(module: HabitatModule, irradiance: number): number {
  if (!isModuleAvailable(module)) {
    return 0;
  }

  if (module.runtimeAttributes.isCharger !== true && !module.capabilities.includes("isCharger")) {
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
    typeof upgradeLevelValue === "number" && Number.isFinite(upgradeLevelValue) ? upgradeLevelValue : 0;

  return baseRate * irradiance * Math.pow(1.5, upgradeLevel);
}

export function spendConstructionPower(
  state: { modules: HabitatModule[]; constructionJobs: Array<{ facilityModuleId: string }> },
  amount: number,
): { spent: boolean; remainingChargeByModuleId: Record<string, number> } {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { spent: true, remainingChargeByModuleId: {} };
  }

  const batteries = state.modules.filter((module) => isModuleAvailable(module) && isBatteryModule(module));

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
