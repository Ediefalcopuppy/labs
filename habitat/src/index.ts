#!/usr/bin/env bun
import "./load-env";
import { Command, InvalidArgumentError } from "commander";
import { randomUUID } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBackendCommand, getBackendState, saveBackendState } from "./client";
import { normalizeState } from "./state/service";
import { readJsonFile, readSqliteState, writeSqliteState } from "./storage";
import type {
  Airlock,
  ConstructionJob,
  Door,
  HabitatInventory,
  HabitatPowerTick,
  HabitatRegistration,
  HabitatState,
  StarterModuleInstance,
  Zone,
} from "./state/types";
import {
  fetchKeplerBlueprintCatalog,
  fetchKeplerHabitatRegistration,
  fetchKeplerResourceCatalog,
  fetchKeplerSolarIrradiance,
  type KeplerBlueprintCatalogEntry,
  type KeplerHabitat,
  type KeplerResourceCatalogEntry,
} from "./kepler-client";
import {
  BATTERY_MAX_CHARGE,
  batteryConstructionDrainPerTick,
  applySolarChargeToBattery,
  batteryRemainingCapacity,
  createUniqueModuleName,
  computeBatteryChargeAfterTick,
  forceConstructionStart,
  normalizeModuleNames,
  planConstructionStart,
  previewConstructionStart,
  spendConstructionPower,
  solarGeneratedChargePerTick,
} from "./construction";
import { canSpendInventory as canSpendInventoryDomain, spendInventoryMaterials as spendInventoryMaterialsDomain } from "./domain/inventory";

type HabitatModule = StarterModuleInstance;

type ModuleState = "online" | "offline" | "idle" | "active" | "damaged";

type ProductionBlueprint = KeplerBlueprintCatalogEntry;

type ResourceCatalogEntry = KeplerResourceCatalogEntry;

type HabitatData = HabitatState;

const dataDir = join(process.cwd(), ".habitat");
const dataPath = join(dataDir, "data.json");
const dataBackupPath = join(dataDir, "data.json.backup");
const sqlitePath = join(dataDir, "habitat.sqlite");

async function readData(): Promise<HabitatData> {
  return getBackendState<HabitatData>();
}

async function writeData(data: HabitatData): Promise<void> {
  await saveBackendState(data);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeRegistration(
  registration: Partial<HabitatRegistration>,
): HabitatRegistration {
  return {
    displayName:
      typeof registration.displayName === "string" && registration.displayName.length > 0
        ? registration.displayName
        : "Unnamed Habitat",
    registeredAt:
      typeof registration.registeredAt === "string" && registration.registeredAt.length > 0
        ? registration.registeredAt
        : new Date(0).toISOString(),
    lastSyncedAt:
      typeof registration.lastSyncedAt === "string" && registration.lastSyncedAt.length > 0
        ? registration.lastSyncedAt
        : typeof registration.registeredAt === "string" && registration.registeredAt.length > 0
          ? registration.registeredAt
          : new Date(0).toISOString(),
    habitatId:
      typeof registration.habitatId === "string" && registration.habitatId.length > 0
        ? registration.habitatId
        : undefined,
    habitatSlug:
      typeof registration.habitatSlug === "string" && registration.habitatSlug.length > 0
        ? registration.habitatSlug
        : undefined,
    catalogVersion:
      typeof registration.catalogVersion === "string" && registration.catalogVersion.length > 0
        ? registration.catalogVersion
        : undefined,
    remoteStatus:
      typeof registration.remoteStatus === "string" && registration.remoteStatus.length > 0
        ? registration.remoteStatus
        : undefined,
    lastSeenAt:
      typeof registration.lastSeenAt === "string" || registration.lastSeenAt === null
        ? registration.lastSeenAt
        : undefined,
  };
}

function linkedRegistrationFromHabitat(
  habitat: KeplerHabitat,
  linkedAt: string,
): HabitatRegistration {
  return {
    displayName: habitat.displayName,
    registeredAt: linkedAt,
    lastSyncedAt: linkedAt,
    habitatId: habitat.id,
    habitatSlug: habitat.habitatSlug,
    catalogVersion: habitat.catalogVersion,
    remoteStatus: habitat.status,
    lastSeenAt: habitat.lastSeenAt ?? null,
  };
}

function normalizeModule(module: HabitatModule): HabitatModule {
  return {
    id: module.id,
    name: module.name ?? module.id,
    blueprintId: module.blueprintId,
    displayName: module.displayName,
    connectedTo: [...module.connectedTo],
    runtimeAttributes: cloneJson(module.runtimeAttributes),
    capabilities: [...module.capabilities],
  };
}

function normalizeConstructionJob(job: ConstructionJob): ConstructionJob {
  return {
    id: job.id,
    moduleName: job.moduleName,
    blueprintId: job.blueprintId,
    facilityModuleId: job.facilityModuleId,
    facilityModuleName: job.facilityModuleName,
    totalBuildTicks: job.totalBuildTicks,
    remainingBuildTicks: job.remainingBuildTicks,
    consumedMaterials: cloneJson(job.consumedMaterials),
    runtimeAttributes: cloneJson(job.runtimeAttributes),
    capabilities: [...job.capabilities],
  };
}

function normalizeBlueprintInputs(blueprint: ProductionBlueprint): Record<string, number> {
  if (!blueprint.inputs || typeof blueprint.inputs !== "object") {
    return {};
  }

  const normalizedInputs: Record<string, number> = {};

  for (const [resourceId, amount] of Object.entries(blueprint.inputs)) {
    if (
      typeof resourceId === "string" &&
      typeof amount === "number" &&
      Number.isFinite(amount) &&
      amount > 0
    ) {
      normalizedInputs[resourceId] = amount;
    }
  }

  return normalizedInputs;
}

function blueprintModuleType(blueprint: ProductionBlueprint): string | undefined {
  const moduleType = blueprint.output?.moduleType;
  return typeof moduleType === "string" && moduleType.length > 0 ? moduleType : undefined;
}

function blueprintOutputLevel(blueprint: ProductionBlueprint): number | undefined {
  const level = blueprint.output?.level;
  return typeof level === "number" && Number.isFinite(level) ? level : undefined;
}

function isModuleAvailableForConstruction(module: HabitatModule): boolean {
  const state = moduleCurrentState(module);
  return state === "online" || state === "idle" || state === "active";
}

function moduleLevel(module: HabitatModule): number {
  const explicitLevel = module.runtimeAttributes.level ?? module.runtimeAttributes.blueprintLevel;
  if (typeof explicitLevel === "number" && Number.isFinite(explicitLevel)) {
    return explicitLevel;
  }

  return 1;
}

function isFacilityBusy(data: HabitatData, moduleId: string): boolean {
  return data.constructionJobs.some((job) => job.facilityModuleId === moduleId);
}

function hasLocalPrerequisite(data: HabitatData, prerequisite: string): boolean {
  return data.modules.some(
    (module) =>
      module.blueprintId === prerequisite ||
      blueprintOutputTypeFromModule(module) === prerequisite ||
      module.capabilities.includes(prerequisite),
  );
}

function blueprintOutputTypeFromModule(module: HabitatModule): string | undefined {
  const moduleType = module.runtimeAttributes.moduleType;
  return typeof moduleType === "string" && moduleType.length > 0 ? moduleType : undefined;
}

function findAvailableFacility(
  data: HabitatData,
  blueprint: ProductionBlueprint,
): HabitatModule | undefined {
  const requiredFacility = blueprint.requiredFacility;
  if (!requiredFacility || typeof requiredFacility !== "object") {
    return undefined;
  }

  const moduleType = requiredFacility.moduleType;
  const minimumLevel =
    typeof requiredFacility.minimumLevel === "number" && Number.isFinite(requiredFacility.minimumLevel)
      ? requiredFacility.minimumLevel
      : 1;

  if (typeof moduleType !== "string" || moduleType.length === 0) {
    return undefined;
  }

  return data.modules.find(
    (module) =>
      (module.blueprintId === moduleType || blueprintOutputTypeFromModule(module) === moduleType) &&
      isModuleAvailableForConstruction(module) &&
      moduleLevel(module) >= minimumLevel &&
      !isFacilityBusy(data, module.id),
  );
}

function hasOnlineSupplyOrLogistics(data: HabitatData): boolean {
  return data.modules.some(
    (module) =>
      isModuleAvailableForConstruction(module) &&
      (module.blueprintId === "supply-cache" ||
        blueprintOutputTypeFromModule(module) === "supply-cache" ||
        module.capabilities.includes("logistics")),
  );
}

function inventoryHasMaterials(
  inventory: HabitatInventory,
  requiredMaterials: Record<string, number>,
): boolean {
  return canSpendInventoryDomain(inventory, requiredMaterials);
}

function spendInventoryMaterials(
  inventory: HabitatInventory,
  requiredMaterials: Record<string, number>,
): HabitatInventory {
  return spendInventoryMaterialsDomain(inventory, requiredMaterials);
}

function hasUsableConstructionPower(data: HabitatData): boolean {
  return data.modules.some((module) => {
    if (!isModuleAvailableForConstruction(module)) {
      return false;
    }

    if (moduleIsCharger(module)) {
      return true;
    }

    return moduleIsBattery(module) && batteryCharge(module) > 0;
  });
}

function createModuleFromConstructionJob(job: ConstructionJob, existingModules: HabitatModule[]): HabitatModule {
  const moduleName = createUniqueModuleName(job.moduleName, existingModules.map((module) => module.name));
  return normalizeModule({
    id: moduleName,
    name: moduleName,
    blueprintId: job.blueprintId,
    displayName: job.moduleName,
    connectedTo: [],
    runtimeAttributes: {
      ...cloneJson(job.runtimeAttributes),
      state: "online",
      status: "online",
    },
    capabilities: [...job.capabilities],
  });
}

function moduleStatus(module: HabitatModule): string {
  const state = module.runtimeAttributes.state;

  if (typeof state === "string" && state.length > 0) {
    return state;
  }

  const status = module.runtimeAttributes.status;
  return typeof status === "string" ? status : "unknown";
}

function isModuleState(value: unknown): value is ModuleState {
  return (
    value === "online" ||
    value === "offline" ||
    value === "idle" ||
    value === "active" ||
    value === "damaged"
  );
}

function moduleCurrentState(module: HabitatModule): ModuleState {
  const candidate = module.runtimeAttributes.state ?? module.runtimeAttributes.status;
  return isModuleState(candidate) ? candidate : "offline";
}

function moduleCurrentPowerDraw(module: HabitatModule): number {
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

function moduleHasFlag(
  module: HabitatModule,
  flag: "isBattery" | "isCharger",
): boolean {
  if (module.runtimeAttributes && module.runtimeAttributes[flag] === true) {
    return true;
  }

  return module.capabilities.includes(flag);
}

function moduleIsLegacyBattery(module: HabitatModule): boolean {
  const outputType = blueprintOutputTypeFromModule(module);
  const runtimeEnergyStorage = module.runtimeAttributes.energyStorageKwh;

  return (
    module.blueprintId === "battery-bank" ||
    outputType === "battery-bank" ||
    module.blueprintId.toLowerCase().includes("battery") ||
    (typeof outputType === "string" && outputType.toLowerCase().includes("battery")) ||
    (typeof runtimeEnergyStorage === "number" && Number.isFinite(runtimeEnergyStorage) && runtimeEnergyStorage > 0)
  );
}

function chargerChargeRate(module: HabitatModule, irradiance: number): number {
  if (!moduleHasFlag(module, "isCharger")) {
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

function sumModulePowerDraw(modules: HabitatModule[]): number {
  return modules.reduce((total, module) => total + moduleCurrentPowerDraw(module), 0);
}

function renderModuleStatusTable(
  rows: Array<{ name: string; state: ModuleState; powerDraw: number; charge: string }>,
): string {
  const headers = ["Name", "State", "Power Draw", "Charge"];
  const widths = rows.reduce(
    (accumulator, row) => {
      accumulator[0] = Math.max(accumulator[0], row.name.length, headers[0].length);
      accumulator[1] = Math.max(accumulator[1], row.state.length, headers[1].length);
      accumulator[2] = Math.max(
        accumulator[2],
        String(row.powerDraw).length,
        headers[2].length,
      );
      accumulator[3] = Math.max(accumulator[3], row.charge.length, headers[3].length);
      return accumulator;
    },
    [headers[0].length, headers[1].length, headers[2].length, headers[3].length],
  );

  const separator = `${"-".repeat(widths[0])}-+-${"-".repeat(widths[1])}-+-${"-".repeat(widths[2])}-+-${"-".repeat(widths[3])}`;
  const lines = [
    `${headers[0].padEnd(widths[0])} | ${headers[1].padEnd(widths[1])} | ${headers[2].padStart(widths[2])} | ${headers[3].padStart(widths[3])}`,
    separator,
  ];

  for (const row of rows) {
    lines.push(
      `${row.name.padEnd(widths[0])} | ${row.state.padEnd(widths[1])} | ${String(row.powerDraw).padStart(widths[2])} | ${row.charge.padStart(widths[3])}`,
    );
  }

  return lines.join("\n");
}

function slugDisplayName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function findZone(name: string): Promise<{ data: HabitatData; zone: Zone }> {
  const data = await readData();
  const zone = data.zones.find((candidate) => candidate.name === name);

  if (!zone) {
    program.error(`No zone named '${name}' exists.`);
    throw new Error("Unreachable after Commander exits.");
  }

  return { data, zone };
}

async function findAirlock(
  name: string,
): Promise<{ data: HabitatData; airlock: Airlock }> {
  const data = await readData();
  const airlock = data.airlocks.find((candidate) => candidate.name === name);

  if (!airlock) {
    program.error(`No airlock named '${name}' exists.`);
    throw new Error("Unreachable after Commander exits.");
  }

  return { data, airlock };
}

async function findDoor(name: string): Promise<{ data: HabitatData; door: Door }> {
  const data = await readData();
  const door = data.doors.find((candidate) => candidate.name === name);

  if (!door) {
    program.error(`No door named '${name}' exists.`);
    throw new Error("Unreachable after Commander exits.");
  }

  return { data, door };
}

async function findModule(
  name: string,
): Promise<{ data: HabitatData; module: HabitatModule }> {
  const data = await readData();
  const module = data.modules.find(
    (candidate) => candidate.name === name || candidate.id === name || candidate.displayName === name,
  );

  if (!module) {
    program.error(`No module named '${name}' exists.`);
    throw new Error("Unreachable after Commander exits.");
  }

  return { data, module };
}

async function findModuleById(
  moduleId: string,
): Promise<{ data: HabitatData; module: HabitatModule }> {
  const data = await readData();
  const module = data.modules.find((candidate) => candidate.id === moduleId);

  if (!module) {
    program.error(`No module with id '${moduleId}' exists.`);
    throw new Error("Unreachable after Commander exits.");
  }

  return { data, module };
}

function blueprintHasFlag(
  blueprint: ProductionBlueprint | undefined,
  flag: "isBattery" | "isCharger",
): boolean {
  if (!blueprint) {
    return false;
  }

  if (blueprint.runtimeAttributes && blueprint.runtimeAttributes[flag] === true) {
    return true;
  }

  return Array.isArray(blueprint.capabilities) && blueprint.capabilities.includes(flag);
}

function moduleIsBattery(module: HabitatModule): boolean {
  return moduleHasFlag(module, "isBattery") || moduleIsLegacyBattery(module);
}

function moduleIsCharger(module: HabitatModule): boolean {
  return moduleHasFlag(module, "isCharger");
}

function batteryCharge(module: HabitatModule): number {
  if (!moduleIsBattery(module)) {
    return Number.NaN;
  }

  const currentEnergy = module.runtimeAttributes.currentEnergyKwh;
  if (typeof currentEnergy === "number" && Number.isFinite(currentEnergy)) {
    return currentEnergy;
  }

  const charge = module.runtimeAttributes.charge;
  return typeof charge === "number" && Number.isFinite(charge) ? charge : BATTERY_MAX_CHARGE;
}

function setBatteryCharge(module: HabitatModule, charge: number): void {
  if (!moduleIsBattery(module)) {
    return;
  }

  module.runtimeAttributes = {
    ...module.runtimeAttributes,
    currentEnergyKwh: Math.max(0, Math.min(BATTERY_MAX_CHARGE, charge)),
    charge: Math.max(0, Math.min(BATTERY_MAX_CHARGE, charge)),
  };
}

function parseChargeLossMultiplier(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }

  return Math.min(1, Math.max(0.01, value));
}

function formatCharge(charge: number): string {
  if (!Number.isFinite(charge)) {
    return "-";
  }

  const rounded = Math.round(charge * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function findBlueprint(
  data: HabitatData,
  blueprintId: string,
): ProductionBlueprint | undefined {
  return data.blueprints.find((candidate) => candidate.blueprintId === blueprintId);
}

function parsePressureLevel(value: string): number {
  const pressureLevel = Number(value);

  if (!Number.isFinite(pressureLevel)) {
    throw new InvalidArgumentError("pressure level must be a number.");
  }

  return pressureLevel;
}

function parseLocked(value: string): boolean {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new InvalidArgumentError("locked must be true or false.");
}

function parseModuleState(value: string): ModuleState {
  if (isModuleState(value)) {
    return value;
  }

  throw new InvalidArgumentError(
    "status must be one of offline, idle, online, active, or damaged.",
  );
}

function parseTickCount(value: string): number {
  const tickCount = Number(value);

  if (!Number.isInteger(tickCount) || tickCount <= 0) {
    throw new InvalidArgumentError("tick count must be a positive whole number.");
  }

  return tickCount;
}

function parseInventoryAmount(value: string): number {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount < 0) {
    throw new InvalidArgumentError("inventory amount must be a non-negative number.");
  }

  return amount;
}

const program = new Command();

program
  .name("habitat")
  .description("A small command-line app for habitat.")
  .version("0.1.0")
  .showHelpAfterError("Try 'habitat --help' to see what habitat can do.")
  .addHelpText(
    "after",
    `
Agent quick reference:
  Use --help on any command group or subcommand for arguments and options.
  Data is scoped to the current working directory.
  Unknown commands return a friendly error and suggest the relevant --help command.

Object schemas:
  zone:    { name: string, purpose: string, status: string }
  airlock: { name: string, pressureLevel: number, locked: boolean }
  door:    { name: string, airlockName?: string }
  module:  { id: string, blueprintId: string, displayName: string, connectedTo: string[], runtimeAttributes: object, capabilities: string[] }
  inventory: { [resourceId: string]: number }
  construction: { id: string, moduleName: string, blueprintId: string, facilityModuleId: string, remainingBuildTicks: number, totalBuildTicks: number }
  power:   { powerConsumedTicks: number }

Command map:
  habitat migrate sqlite
  habitat register --name <habitat name>
  habitat link --id <habitatId>
  habitat unregister
  habitat status
  habitat construct <blueprint-id>
  habitat tick <count>
  habitat zone create <name> --purpose <purpose> --status <status>
  habitat zone list
  habitat zone show <name>
  habitat zone update <name> [--purpose <purpose>] [--status <status>]
  habitat zone delete <name>
  habitat airlock create <name> --pressure-level <number> --locked <true|false>
  habitat airlock list
  habitat airlock show <name>
  habitat airlock update <name> [--pressure-level <number>] [--locked <true|false>]
  habitat airlock add-door <airlockName> <doorName>
  habitat airlock delete <name>
  habitat module create <name> --blueprint-id <id>
  habitat module -l
  habitat module list
  habitat module status
  habitat module set-status <module-id> <status>
  habitat module normalize-names
  habitat module show <name>
  habitat module update <name> [--name <newName>] [--status <status>]
  habitat module delete <name>
  habitat blueprint list
  habitat blueprint show <blueprint-id>
  habitat resource list
  habitat inventory list
  habitat inventory set <resource-id> <amount>
  habitat construction list
  habitat construction cancel <job-id>
  habitat debug construct <blueprint-id>
  habitat door create <name>
  habitat door list
  habitat door show <name>
  habitat door update <name> --name <newName>
  habitat door delete <name>

Common workflow:
  habitat register --name "Artemis Ridge"
  habitat link --id hab_123456
  habitat unregister
  habitat status
  habitat construct greenhouse
  habitat tick 1
  habitat debug construct greenhouse
  habitat module list
  habitat module -l
  habitat module status
  habitat module set-status <module-id> <status>
  habitat module create greenhouse --blueprint-id greenhouse
  habitat blueprint list
  habitat blueprint show greenhouse
  habitat resource list
  habitat inventory set basalt-composite 500
  habitat construction list
  habitat zone create kitchen --purpose cooking --status active
  habitat airlock create main --pressure-level 2.5 --locked true
  habitat door create outer
  habitat airlock add-door main outer
  habitat airlock show main
  habitat door show outer

Data:
  Served by the local Habitat backend started with bun run server.
  The file shape is { "zones": [], "airlocks": [], "doors": [], "modules": [], "blueprints": [], "inventory": {}, "constructionJobs": [], "power": { "powerConsumedTicks": 0 }, "registration": {} }.
`,
  );

const migrateCommand = new Command("migrate")
  .description("Migrate local Habitat data between storage formats.")
  .showHelpAfterError("Try 'habitat migrate --help' to see migration commands.");

migrateCommand
  .command("sqlite")
  .description("Transfer the legacy local JSON data into SQLite.")
  .action(async () => {
    const state = normalizeState(await readJsonFile(dataPath));
    if (await readSqliteState(sqlitePath) !== undefined) {
      program.error("SQLite data already exists; refusing to overwrite it.");
    }

    await copyFile(dataPath, dataBackupPath);
    await writeSqliteState(sqlitePath, state);
    console.log(`Migrated legacy Habitat data to ${sqlitePath}.`);
    console.log(`Saved the original JSON data to ${dataBackupPath}.`);
  });

migrateCommand
  .command("restore")
  .description("Restore data.json.backup and replace the SQLite state with it.")
  .action(async () => {
    const state = normalizeState(await readJsonFile(dataBackupPath));
    await writeFile(dataPath, `${JSON.stringify(state, null, 2)}\n`);
    await writeSqliteState(sqlitePath, state);

    console.log(`Restored legacy local JSON data to ${dataPath}.`);
    console.log(`Rebuilt SQLite state at ${sqlitePath}.`);
  });

program.addCommand(migrateCommand);

program.on("command:*", ([command]) => {
  program.error(`Habitat does not know the command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program
  .command("register")
  .description("Register this habitat through the backend.")
  .requiredOption("-n, --name <habitatName>", "habitat display name")
  .action(async (options: { name: string }) => {
    const data = await readData();

    if (data.registration) {
      program.error(`This directory is already registered as '${data.registration.displayName}'.`);
    }

    const now = new Date().toISOString();
    data.registration = {
      displayName: options.name,
      registeredAt: now,
      lastSyncedAt: now,
    };
    await writeData(data);

    console.log(`Registered habitat '${options.name}'.`);
  });

program
  .command("link")
  .description("Link this directory to an existing Kepler habitat.")
  .requiredOption("-i, --id <habitatId>", "existing Kepler habitat id")
  .addHelpText(
    "after",
    `
Looks up an already-registered habitat from Kepler and stores its identity through the backend.
This links the current habitat id to an existing habitat; it does not create a new habitat and it does not hydrate starter modules.

Examples:
  habitat link --id hab_123456
`,
  )
  .action(async (options: { id: string }) => {
    const data = await readData();

    if (data.registration) {
      program.error(`This directory is already registered as '${data.registration.displayName}'.`);
    }

    const habitat = await fetchKeplerHabitatRegistration(options.id);
    const now = new Date().toISOString();
    data.registration = linkedRegistrationFromHabitat(habitat, now);
    await writeData(data);

    console.log(`Linked habitat '${habitat.displayName}' (${habitat.id}).`);
  });

program
  .command("unregister")
  .description("Remove the habitat registration.")
  .action(async () => {
    const data = await readData();

    if (!data.registration) {
      console.log("Not registered.");
      return;
    }

    const displayName = data.registration.displayName;
    delete data.registration;
    await writeData(data);

    console.log(`Unregistered habitat '${displayName}'.`);
  });

program
  .command("status")
  .description("Show the habitat status.")
  .addHelpText(
    "after",
    `
Shows the registered habitat name, object counts, stored power ticks, and a module power summary.

Examples:
  habitat status
`,
  )
  .action(async () => {
    const data = await readData();
    const moduleStates = data.modules.reduce<Record<ModuleState | "unknown", number>>(
      (counts, module) => {
        const state = moduleCurrentState(module);
        counts[state] = (counts[state] ?? 0) + 1;
        return counts;
      },
      { online: 0, offline: 0, idle: 0, active: 0, damaged: 0, unknown: 0 },
    );
    const totalPowerDraw = sumModulePowerDraw(data.modules);

    console.log(`Registered: ${data.registration ? "yes" : "no"}`);
    if (data.registration) {
      console.log(`Habitat name: ${data.registration.displayName}`);
      if (data.registration.habitatId) {
        console.log(`Habitat id: ${data.registration.habitatId}`);
      }
      if (data.registration.habitatSlug) {
        console.log(`Habitat slug: ${data.registration.habitatSlug}`);
      }
      if (data.registration.remoteStatus) {
        console.log(`Remote status: ${data.registration.remoteStatus}`);
      }
      if (data.registration.catalogVersion) {
        console.log(`Catalog version: ${data.registration.catalogVersion}`);
      }
      if (data.registration.lastSeenAt) {
        console.log(`Last seen at: ${data.registration.lastSeenAt}`);
      }
      console.log(`Registered at: ${data.registration.registeredAt}`);
      console.log(`Last synced at: ${data.registration.lastSyncedAt}`);
    }

    console.log(`Zones: ${data.zones.length}`);
    console.log(`Airlocks: ${data.airlocks.length}`);
    console.log(`Doors: ${data.doors.length}`);
    console.log(`Modules: ${data.modules.length}`);
    console.log(`Blueprints: ${data.blueprints.length}`);
    console.log(`Inventory resources: ${Object.keys(data.inventory).length}`);
    console.log(`Construction jobs: ${data.constructionJobs.length}`);
    console.log(`Power consumed ticks: ${data.power.powerConsumedTicks}`);

    if (data.modules.length > 0) {
      console.log(
        `Module states: online ${moduleStates.online}, offline ${moduleStates.offline}, idle ${moduleStates.idle}, active ${moduleStates.active}, damaged ${moduleStates.damaged}, unknown ${moduleStates.unknown}`,
      );
      console.log(`Total current module power draw: ${totalPowerDraw}`);
      console.log(`Energy cost for one tick: ${totalPowerDraw}`);
    }
  });

const solarCommand = new Command("solar")
  .description("Inspect live solar conditions from Kepler.")
  .showHelpAfterError("Try 'habitat solar --help' to see solar commands.")
  .addHelpText(
    "after",
    `
Commands:
  habitat solar status

Notes:
  solar commands read live irradiance from Kepler.
`,
  );

solarCommand
  .command("status")
  .description("Show live solar irradiance and charger output.")
  .addHelpText(
    "after",
    `
Reports the current Kepler irradiance value, a normalized solar factor, and the estimated
charge per tick for local charger modules.

Examples:
  habitat solar status
`,
  )
  .action(async () => {
    const data = await readData();
    const irradiance = await fetchKeplerSolarIrradiance();
    const chargers = data.modules.filter((module) => moduleIsCharger(module));
    const totalChargePerTick = chargers.reduce((total, module) => total + chargerChargeRate(module, irradiance), 0);
    const normalizedSolarFactor = Math.max(0, Math.round(irradiance * 1000) / 1000);

    console.log(`Live irradiance: ${irradiance}`);
    console.log(`Solar factor: ${normalizedSolarFactor}`);
    console.log(`Charger modules: ${chargers.length}`);
    console.log(`Estimated charger output per tick: ${totalChargePerTick}`);
  });

solarCommand.on("command:*", ([command]) => {
  solarCommand.error(`Habitat does not know the solar command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program.addCommand(solarCommand);

const powerCommand = new Command("power")
  .description("Inspect habitat power information.")
  .showHelpAfterError("Try 'habitat power --help' to see power commands.")
  .addHelpText(
    "after",
    `
Commands:
  habitat power overview

Examples:
  habitat power overview
`,
  );

powerCommand
  .command("overview")
  .description("Show a power summary.")
  .action(async () => {
    const overview = await getBackendCommand<{
      registered: boolean;
      moduleStates: Record<string, number>;
      totalPowerDraw: number;
      powerConsumedTicks: number;
      moduleCount: number;
      constructionJobs: number;
    }>("/commands/power/overview");

    console.log(`Registered: ${overview.registered ? "yes" : "no"}`);
    console.log(`Modules: ${overview.moduleCount}`);
    console.log(`Construction jobs: ${overview.constructionJobs}`);
    console.log(`Power consumed ticks: ${overview.powerConsumedTicks}`);
    console.log(`Total current module power draw: ${overview.totalPowerDraw}`);
    console.log(`Module states: ${JSON.stringify(overview.moduleStates)}`);
  });

powerCommand.on("command:*", ([command]) => {
  powerCommand.error(`Habitat does not know the power command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program.addCommand(powerCommand);

program
  .command("construct")
  .description("Start construction from a live Kepler blueprint through the backend.")
  .argument("<blueprint-id>", "published blueprint id")
  .option("-d, --display-name <displayName>", "visible module display name")
  .option("--dry-run", "check whether construction can start without changing local files")
  .addHelpText(
    "after",
    `
The blueprint is fetched from Kepler at command time, so the backend remains the source of truth for build properties and construction state.

Examples:
  habitat construct greenhouse
`,
  )
  .action(async (blueprintId: string, options: { dryRun?: boolean; displayName?: string }) => {
    const data = await readData();

    const blueprints = await fetchKeplerBlueprintCatalog();
    const blueprint = blueprints.find(
      (candidate) => candidate.blueprintId === blueprintId || candidate.id === blueprintId,
    );

    if (!blueprint) {
      program.error(`No blueprint with id '${blueprintId}' exists in Kepler.`);
      throw new Error("Unreachable after Commander exits.");
    }

    const report = previewConstructionStart({
      blueprint,
      habitat: data,
      displayName: options.displayName ?? blueprint.displayName,
    });

    if (options.dryRun) {
      console.log(`Required facility exists: ${report.requiredFacilityExists ? "yes" : "no"}`);
      console.log(`Fabricator available: ${report.fabricatorAvailable ? "yes" : "no"}`);
      console.log(`Supply cache online: ${report.supplyCacheOnline ? "yes" : "no"}`);
      console.log(`Prerequisites met: ${report.prerequisitesMet ? "yes" : "no"}`);
      console.log(`Inventory has required resources: ${report.inventoryHasMaterials ? "yes" : "no"}`);
      console.log(`Module to be created: ${report.moduleToBeCreated}`);
      console.log(`Resources to be spent: ${JSON.stringify(report.resourcesToBeSpent)}`);
      console.log(`Construction can start: ${report.canStart ? "yes" : "no"}`);
      return;
    }

    if (data.constructionJobs.some((job) => job.blueprintId === blueprintId)) {
      program.error(`A construction job for blueprint '${blueprintId}' already exists.`);
    }

    data.blueprints = blueprints;

    const plan = planConstructionStart({
      blueprint,
      habitat: data,
      displayName: options.displayName ?? blueprint.displayName,
    });

    data.inventory = spendInventoryMaterials(data.inventory, plan.consumedMaterials);
    data.constructionJobs.push(
      normalizeConstructionJob({
        id: `construction_${randomUUID()}`,
        moduleName: plan.moduleName,
        blueprintId: blueprint.blueprintId,
        facilityModuleId: plan.facility.id,
        facilityModuleName: plan.facility.displayName,
        totalBuildTicks: plan.totalBuildTicks,
        remainingBuildTicks: plan.totalBuildTicks,
        consumedMaterials: plan.consumedMaterials,
        runtimeAttributes: plan.runtimeAttributes,
        capabilities: plan.capabilities,
      }),
    );
    await writeData(data);

    console.log(
      `Started construction for '${plan.displayName}' from blueprint '${blueprint.blueprintId}' using facility '${plan.facility.displayName}'.`,
    );
  });

program
  .command("tick")
  .description("Advance the habitat simulation by a number of ticks.")
  .argument("<count>", "number of ticks to advance", parseTickCount)
  .addHelpText(
    "after",
    `
Each tick updates local power consumption counters.
Construction jobs advance one tick at a time when the habitat has usable power.

Examples:
  habitat tick 1
  habitat tick 12
`,
  )
  .action(async (count: number) => {
    const data = await readData();
    const completedJobs: string[] = [];
    let advancedConstructionTicks = 0;
    let pausedConstructionTicks = 0;
    let energyCost = 0;

    for (let step = 0; step < count; step += 1) {
      const irradiance = await fetchKeplerSolarIrradiance();
      const totalPowerDraw = sumModulePowerDraw(data.modules);
      const batteries = data.modules.filter((module) => moduleIsBattery(module));
      const onlineConsumers = data.modules.filter(
        (module) =>
          moduleCurrentState(module) === "online" &&
          !moduleIsBattery(module) &&
          !moduleIsCharger(module),
      );
      const onlineChargers = data.modules.filter(
        (module) => moduleCurrentState(module) === "online" && moduleIsCharger(module),
      );
      const totalDrain = onlineConsumers.length;
      const totalCharge = onlineChargers.reduce(
        (total, module) => total + chargerChargeRate(module, irradiance),
        0,
      );
      const drainPerBattery = batteries.length > 0 ? totalDrain / batteries.length : 0;
      const chargePerBattery = batteries.length > 0 ? totalCharge / batteries.length : 0;
      const solarChargers = onlineChargers;
      const generatedCharge = solarChargers.reduce(
        (total, module) => total + solarGeneratedChargePerTick(module, irradiance),
        0,
      );
      const totalRemainingCapacity = batteries.reduce((total, module) => total + batteryRemainingCapacity(module), 0);

      for (const module of data.modules) {
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
        const batteryShare = totalRemainingCapacity > 0
          ? generatedCharge * (remainingCapacity / totalRemainingCapacity)
          : 0;
        const nextCharge = computeBatteryChargeAfterTick(
          module,
          chargePerBattery,
          drainPerBattery,
        );
        module.runtimeAttributes = {
          ...module.runtimeAttributes,
          currentEnergyKwh: nextCharge,
          charge: nextCharge,
        };
        const nextSolarCharge = applySolarChargeToBattery(module, batteryShare);

        module.runtimeAttributes = {
          ...module.runtimeAttributes,
          currentEnergyKwh: nextSolarCharge,
          charge: nextSolarCharge,
        };
      }

      data.power.powerConsumedTicks += totalPowerDraw;
      energyCost += totalPowerDraw;

      if (data.constructionJobs.length === 0) {
        continue;
      }

      const nextJobs: ConstructionJob[] = [];

      for (const job of data.constructionJobs) {
        const facility = data.modules.find((module) => module.id === job.facilityModuleId);
        const constructionPower = spendConstructionPower(data, 1);
        if (
          !facility ||
          !isModuleAvailableForConstruction(facility) ||
          !constructionPower.spent
        ) {
          pausedConstructionTicks += 1;
          nextJobs.push(job);
          continue;
        }

        const remainingBuildTicks = job.remainingBuildTicks - 1;
        advancedConstructionTicks += 1;

        if (remainingBuildTicks <= 0) {
          data.modules.push(createModuleFromConstructionJob(job, data.modules));
          completedJobs.push(job.moduleName);
          continue;
        }

        nextJobs.push(
          normalizeConstructionJob({
            ...job,
            remainingBuildTicks,
          }),
        );
      }

      data.constructionJobs = nextJobs;
    }

    await writeData(data);

    console.log(`Advanced habitat by ${count} tick(s).`);
    console.log(`Updated power consumption counters on ${data.modules.length} module(s).`);
    console.log(`Energy cost for ${count} tick(s): ${energyCost}`);
    if (advancedConstructionTicks > 0) {
      console.log(`Advanced ${advancedConstructionTicks} construction tick(s).`);
    }
    if (pausedConstructionTicks > 0) {
      console.log(`Paused ${pausedConstructionTicks} construction tick(s) due to unavailable power.`);
    }
    if (completedJobs.length > 0) {
      console.log(`Completed modules: ${completedJobs.join(", ")}.`);
    }
  });

const zone = new Command("zone")
  .description("Manage zones.")
  .showHelpAfterError("Try 'habitat zone --help' to see zone commands.")
  .addHelpText(
    "after",
    `
Schema:
  { name: string, purpose: string, status: string }

Commands:
  habitat zone create <name> --purpose <purpose> --status <status>
  habitat zone list
  habitat zone show <name>
  habitat zone update <name> [--purpose <purpose>] [--status <status>]
  habitat zone delete <name>

Examples:
  habitat zone create kitchen --purpose cooking --status active
  habitat zone list
  habitat zone show kitchen
  habitat zone update kitchen --purpose prep --status paused
  habitat zone delete kitchen

Notes:
  name is the lookup key for show, update, and delete.
  update changes only the fields you provide.
  zones are stored in backend habitat state.
`,
  );

zone
  .command("create")
  .description("Create a zone.")
  .argument("<name>", "zone name")
  .requiredOption("-p, --purpose <purpose>", "zone purpose")
  .requiredOption("-s, --status <status>", "zone status")
  .action(async (name: string, options: Pick<Zone, "purpose" | "status">) => {
    const data = await readData();

    if (data.zones.some((candidate) => candidate.name === name)) {
      program.error(`A zone named '${name}' already exists.`);
    }

    data.zones.push({ name, purpose: options.purpose, status: options.status });
    await writeData(data);

    console.log(`Created zone '${name}'.`);
  });

zone
  .command("list")
  .description("List zones.")
  .action(async () => {
    const data = await readData();

    if (data.zones.length === 0) {
      console.log("No zones found.");
      return;
    }

    for (const zone of data.zones) {
      console.log(`${zone.name} | purpose: ${zone.purpose} | status: ${zone.status}`);
    }
  });

zone
  .command("show")
  .description("Show one zone.")
  .argument("<name>", "zone name")
  .action(async (name: string) => {
    const { zone } = await findZone(name);

    console.log(`Name: ${zone.name}`);
    console.log(`Purpose: ${zone.purpose}`);
    console.log(`Status: ${zone.status}`);
  });

zone
  .command("update")
  .description("Update a zone.")
  .argument("<name>", "zone name")
  .option("-p, --purpose <purpose>", "new zone purpose")
  .option("-s, --status <status>", "new zone status")
  .action(async (name: string, options: Partial<Pick<Zone, "purpose" | "status">>) => {
    if (options.purpose === undefined && options.status === undefined) {
      program.error("Provide --purpose, --status, or both.");
    }

    const { data, zone } = await findZone(name);

    zone.purpose = options.purpose ?? zone.purpose;
    zone.status = options.status ?? zone.status;
    await writeData(data);

    console.log(`Updated zone '${name}'.`);
  });

zone
  .command("delete")
  .description("Delete a zone.")
  .argument("<name>", "zone name")
  .action(async (name: string) => {
    const data = await readData();
    const nextZones = data.zones.filter((zone) => zone.name !== name);

    if (nextZones.length === data.zones.length) {
      program.error(`No zone named '${name}' exists.`);
    }

    data.zones = nextZones;
    await writeData(data);

    console.log(`Deleted zone '${name}'.`);
  });

zone.on("command:*", ([command]) => {
  zone.error(`Habitat does not know the zone command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program.addCommand(zone);

const airlock = new Command("airlock")
  .description("Manage airlocks.")
  .showHelpAfterError("Try 'habitat airlock --help' to see airlock commands.")
  .addHelpText(
    "after",
    `
Schema:
  { name: string, pressureLevel: number, locked: boolean }

Commands:
  habitat airlock create <name> --pressure-level <number> --locked <true|false>
  habitat airlock list
  habitat airlock show <name>
  habitat airlock update <name> [--pressure-level <number>] [--locked <true|false>]
  habitat airlock add-door <airlockName> <doorName>
  habitat airlock delete <name>

Examples:
  habitat airlock create main --pressure-level 2.5 --locked true
  habitat airlock list
  habitat airlock show main
  habitat airlock update main --pressure-level 1 --locked false
  habitat airlock add-door main outer
  habitat airlock delete main

Notes:
  name is the lookup key for show, update, add-door, and delete.
  --pressure-level accepts a number.
  --locked accepts true or false.
  add-door requires both the airlock and door to already exist.
  add-door stores the airlock name on the door as airlockName.
  deleting an airlock clears airlockName from attached doors.
  update changes only the fields you provide.
  airlocks are stored in backend habitat state.
`,
  );

airlock
  .command("create")
  .description("Create an airlock.")
  .argument("<name>", "airlock name")
  .requiredOption(
    "-p, --pressure-level <pressureLevel>",
    "airlock pressure level",
    parsePressureLevel,
  )
  .requiredOption(
    "-l, --locked <locked>",
    "whether the airlock is locked: true or false",
    parseLocked,
  )
  .action(
    async (
      name: string,
      options: Pick<Airlock, "pressureLevel" | "locked">,
    ) => {
      const data = await readData();

      if (data.airlocks.some((candidate) => candidate.name === name)) {
        program.error(`An airlock named '${name}' already exists.`);
      }

      data.airlocks.push({
        name,
        pressureLevel: options.pressureLevel,
        locked: options.locked,
      });
      await writeData(data);

      console.log(`Created airlock '${name}'.`);
    },
  );

airlock
  .command("list")
  .description("List airlocks.")
  .action(async () => {
    const data = await readData();

    if (data.airlocks.length === 0) {
      console.log("No airlocks found.");
      return;
    }

    for (const airlock of data.airlocks) {
      const doors = data.doors
        .filter((door) => door.airlockName === airlock.name)
        .map((door) => door.name);
      console.log(
        `${airlock.name} | pressure level: ${airlock.pressureLevel} | locked: ${airlock.locked} | doors: ${doors.length > 0 ? doors.join(", ") : "none"}`,
      );
    }
  });

airlock
  .command("show")
  .description("Show one airlock.")
  .argument("<name>", "airlock name")
  .action(async (name: string) => {
    const { data, airlock } = await findAirlock(name);
    const doors = data.doors
      .filter((door) => door.airlockName === airlock.name)
      .map((door) => door.name);

    console.log(`Name: ${airlock.name}`);
    console.log(`Pressure level: ${airlock.pressureLevel}`);
    console.log(`Locked: ${airlock.locked}`);
    console.log(`Doors: ${doors.length > 0 ? doors.join(", ") : "none"}`);
  });

airlock
  .command("update")
  .description("Update an airlock.")
  .argument("<name>", "airlock name")
  .option(
    "-p, --pressure-level <pressureLevel>",
    "new airlock pressure level",
    parsePressureLevel,
  )
  .option(
    "-l, --locked <locked>",
    "whether the airlock is locked: true or false",
    parseLocked,
  )
  .action(
    async (
      name: string,
      options: Partial<Pick<Airlock, "pressureLevel" | "locked">>,
    ) => {
      if (options.pressureLevel === undefined && options.locked === undefined) {
        program.error("Provide --pressure-level, --locked, or both.");
      }

      const { data, airlock } = await findAirlock(name);

      airlock.pressureLevel = options.pressureLevel ?? airlock.pressureLevel;
      airlock.locked = options.locked ?? airlock.locked;
      await writeData(data);

      console.log(`Updated airlock '${name}'.`);
    },
  );

airlock
  .command("add-door")
  .description("Attach a door to an airlock.")
  .argument("<airlockName>", "airlock name")
  .argument("<doorName>", "door name")
  .action(async (airlockName: string, doorName: string) => {
    const data = await readData();
    const airlock = data.airlocks.find((candidate) => candidate.name === airlockName);
    const door = data.doors.find((candidate) => candidate.name === doorName);

    if (!airlock) {
      program.error(`No airlock named '${airlockName}' exists.`);
      throw new Error("Unreachable after Commander exits.");
    }

    if (!door) {
      program.error(`No door named '${doorName}' exists.`);
      throw new Error("Unreachable after Commander exits.");
    }

    door.airlockName = airlock.name;
    await writeData(data);

    console.log(`Attached door '${doorName}' to airlock '${airlockName}'.`);
  });

airlock
  .command("delete")
  .description("Delete an airlock.")
  .argument("<name>", "airlock name")
  .action(async (name: string) => {
    const data = await readData();
    const nextAirlocks = data.airlocks.filter((airlock) => airlock.name !== name);

    if (nextAirlocks.length === data.airlocks.length) {
      program.error(`No airlock named '${name}' exists.`);
    }

    data.airlocks = nextAirlocks;
    for (const door of data.doors) {
      if (door.airlockName === name) {
        delete door.airlockName;
      }
    }
    await writeData(data);

    console.log(`Deleted airlock '${name}'.`);
  });

airlock.on("command:*", ([command]) => {
  airlock.error(`Habitat does not know the airlock command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program.addCommand(airlock);

const moduleCommand = new Command("module")
  .description("Manage modules.")
  .showHelpAfterError("Try 'habitat module --help' to see module commands.")
  .addHelpText(
    "after",
    `
Schema:
  { id: string, blueprintId: string, displayName: string, connectedTo: string[], runtimeAttributes: object, capabilities: string[] }

Commands:
  habitat module create <name> --blueprint-id <id>
  habitat module -l
  habitat module list
  habitat module status
  habitat module set-status <module-id> <status>
  habitat module normalize-names
  habitat module show <name>
  habitat module update <name> [--name <newName>] [--status <status>]
  habitat module delete <name>

Notes:
  name is the lookup key and displayName for modules.
  create starts a construction job from the cached blueprint catalog.
  the finished module appears only after enough ticks complete the job.
  once built, the module is independent from the catalog.
  -l lists the cached blueprint ids and display names.
  update changes the display name and/or runtime status.
  status reads runtimeAttributes.state first, then runtimeAttributes.status.
  power draw prefers runtimeAttributes.powerDrawByState, then state-specific power draw fields, then runtimeAttributes.powerDraw.
  batteries also display charge, capped at 100.
  set-status changes only runtimeAttributes.status on the matching module id.
  normalize-names converts module names to lowercase slugs with the lowest available numeric suffix.
`,
  );

moduleCommand.option("-l, --list-blueprints", "list available blueprint ids and display names");

moduleCommand.action(async (options: { listBlueprints?: boolean } = {}) => {
  if (!options.listBlueprints) {
    moduleCommand.help();
    return;
  }

  const data = await readData();

  if (data.blueprints.length === 0) {
    console.log("No blueprints found.");
    return;
  }

  for (const blueprint of data.blueprints) {
    console.log(`${blueprint.blueprintId} | ${blueprint.displayName}`);
  }
});

moduleCommand
  .command("create")
  .description("Start construction from a cached blueprint.")
  .argument("<name>", "module display name")
  .option("-d, --display-name <displayName>", "visible module display name")
  .requiredOption("-b, --blueprint-id <blueprintId>", "published blueprint id")
  .addHelpText(
    "after",
    `
The blueprint must exist in the cached blueprint catalog and must output a module.
Starting construction spends the required materials and creates a construction job.
The finished module appears only after enough ticks complete the job.
`,
  )
  .action(async (name: string, options: { blueprintId: string; displayName?: string }) => {
    const data = await readData();
    const blueprint = findBlueprint(data, options.blueprintId);

    if (!blueprint) {
      program.error(`No blueprint with id '${options.blueprintId}' exists in the cached catalog.`);
      throw new Error("Unreachable after Commander exits.");
    }

    if (blueprint.output?.itemType !== "module") {
      program.error(`Blueprint '${options.blueprintId}' does not create a module.`);
      throw new Error("Unreachable after Commander exits.");
    }

    if (blueprint.status !== "published") {
      program.error(`Blueprint '${options.blueprintId}' is not published.`);
    }

    const requiredMaterials = normalizeBlueprintInputs(blueprint);
    if (!inventoryHasMaterials(data.inventory, requiredMaterials)) {
      program.error(`Local inventory does not contain the required materials for '${options.blueprintId}'.`);
    }

    if (!hasOnlineSupplyOrLogistics(data)) {
      program.error("Construction requires an online supply cache or logistics module.");
    }

    if (!hasUsableConstructionPower(data)) {
      program.error("Construction requires usable habitat power.");
    }

    if (Array.isArray(blueprint.prerequisites)) {
      const missingPrerequisite = blueprint.prerequisites.find(
        (prerequisite) => !hasLocalPrerequisite(data, prerequisite),
      );

      if (missingPrerequisite) {
        program.error(`Missing prerequisite '${missingPrerequisite}' for '${options.blueprintId}'.`);
      }
    }

    const facility = findAvailableFacility(data, blueprint);
    if (!facility) {
      program.error(`No available facility can build '${options.blueprintId}'.`);
      throw new Error("Unreachable after Commander exits.");
    }

    const buildTicksCandidate = blueprint.buildTicks;
    if (
      typeof buildTicksCandidate !== "number" ||
      !Number.isFinite(buildTicksCandidate) ||
      buildTicksCandidate <= 0
    ) {
      program.error(`Blueprint '${options.blueprintId}' does not define a valid build time.`);
      throw new Error("Unreachable after Commander exits.");
    }
    const buildTicks = buildTicksCandidate;

    data.inventory = spendInventoryMaterials(data.inventory, requiredMaterials);
    data.constructionJobs.push(
      normalizeConstructionJob({
        id: `construction_${randomUUID()}`,
        moduleName: name,
        blueprintId: blueprint.blueprintId,
        facilityModuleId: facility.id,
        facilityModuleName: facility.displayName,
        totalBuildTicks: buildTicks,
        remainingBuildTicks: buildTicks,
        consumedMaterials: requiredMaterials,
        runtimeAttributes: {
          ...cloneJson(blueprint.runtimeAttributes ?? {}),
          ...(typeof blueprint.level === "number" && Number.isFinite(blueprint.level)
            ? { blueprintLevel: blueprint.level }
            : {}),
          ...(typeof blueprintOutputLevel(blueprint) === "number"
            ? { level: blueprintOutputLevel(blueprint) }
            : {}),
          ...(blueprintModuleType(blueprint) ? { moduleType: blueprintModuleType(blueprint) } : {}),
          ...(blueprintHasFlag(blueprint, "isBattery") ? { charge: 100 } : {}),
        },
        capabilities: [...(blueprint.capabilities ?? [])],
      }),
    );
    await writeData(data);

    console.log(
      `Started construction for '${options.displayName ?? name}' using facility '${facility.displayName}'.`,
    );
  });

moduleCommand
  .command("list")
  .description("List modules.")
  .action(async () => {
    const data = await readData();

    if (data.modules.length === 0) {
      console.log("No modules found.");
      return;
    }

    for (const module of data.modules) {
      console.log(
        `${module.name} | display: ${module.displayName} | blueprint: ${module.blueprintId} | status: ${moduleStatus(module)} | capabilities: ${module.capabilities.join(", ")}`,
      );
    }
  });

moduleCommand
  .command("status")
  .description("Show module states and power draw.")
  .addHelpText(
    "after",
    `
Shows a text table with the module name, current state, and current power draw.
Batteries add a charge column.
The summary line reports the total current power draw and the one-tick energy cost.

Examples:
  habitat module status
`,
  )
  .action(async () => {
    const data = await readData();

    if (data.modules.length === 0) {
      console.log("No modules found.");
      console.log("Total current power draw: 0");
      console.log("Energy cost for one tick: 0");
      return;
    }

    const rows = data.modules.map((module) => ({
      name: slugDisplayName(module.displayName),
      state: moduleCurrentState(module),
      powerDraw: moduleCurrentPowerDraw(module),
      charge: moduleIsBattery(module) ? formatCharge(batteryCharge(module)) : "-",
    }));
    const totalPowerDraw = rows.reduce((total, row) => total + row.powerDraw, 0);

    console.log(renderModuleStatusTable(rows));
    console.log(`Total current power draw: ${totalPowerDraw}`);
    console.log(`Energy cost for one tick: ${totalPowerDraw}`);
  });

moduleCommand
  .command("set-status")
  .description("Set a module's runtime state.")
  .argument("<module-id>", "module id")
  .argument("<status>", "module status", parseModuleState)
  .action(async (moduleId: string, status: ModuleState) => {
    const { data, module } = await findModuleById(moduleId);

    module.runtimeAttributes = {
      ...module.runtimeAttributes,
      status,
    };

    await writeData(data);

    console.log(
      `Updated module '${moduleId}' to status '${status}' (power draw: ${moduleCurrentPowerDraw(module)}).`,
    );
  });

moduleCommand
  .command("normalize-names")
  .description("Convert all local module names to slug-number form.")
  .action(async () => {
    const data = await readData();
    data.modules = normalizeModuleNames(data.modules);
    const moduleIds = new Map(data.modules.map((module) => [module.id, module.name]));
    data.modules = data.modules.map((module) => ({
      ...module,
      id: module.name,
      connectedTo: module.connectedTo.map((id) => moduleIds.get(id) ?? id),
    }));
    data.constructionJobs = data.constructionJobs.map((job) => ({
      ...job,
      facilityModuleId: moduleIds.get(job.facilityModuleId) ?? job.facilityModuleId,
    }));
    await writeData(data);

    console.log(`Normalized ${data.modules.length} module name(s).`);
  });

moduleCommand
  .command("show")
  .description("Show one module.")
  .argument("<name>", "module display name")
  .action(async (name: string) => {
    const { data, module } = await findModule(name);
    const isBattery = moduleIsBattery(module);

    console.log(`Name: ${module.name}`);
    console.log(`Display name: ${module.displayName}`);
    console.log(`ID: ${module.id}`);
    console.log(`Blueprint: ${module.blueprintId}`);
    console.log(`Status: ${moduleStatus(module)}`);
    console.log(`Connected to: ${module.connectedTo.length > 0 ? module.connectedTo.join(", ") : "none"}`);
    console.log(`Capabilities: ${module.capabilities.length > 0 ? module.capabilities.join(", ") : "none"}`);
    if (isBattery) {
      console.log(`Charge: ${formatCharge(batteryCharge(module))}/${BATTERY_MAX_CHARGE}`);
    }
    console.log(`Runtime attributes: ${JSON.stringify(module.runtimeAttributes, null, 2)}`);
  });

moduleCommand
  .command("update")
  .description("Update a module.")
  .argument("<name>", "module name, id, or display name")
  .option("-n, --name <newName>", "new module display name")
  .option("-s, --status <status>", "new module status")
  .action(async (name: string, options: { name?: string; status?: string }) => {
    if (options.name === undefined && options.status === undefined) {
      program.error("Provide --name, --status, or both.");
    }

    const { data, module } = await findModule(name);

    if (options.name && data.modules.some((candidate) => candidate.displayName === options.name && candidate !== module)) {
      program.error(`A module named '${options.name}' already exists.`);
    }

    if (options.name) {
      module.displayName = options.name;
    }

    if (options.status) {
      module.runtimeAttributes = {
        ...module.runtimeAttributes,
        state: options.status,
        status: options.status,
      };
    }

    await writeData(data);

    console.log(`Updated module '${name}'.`);
  });

moduleCommand
  .command("delete")
  .description("Delete a module.")
  .argument("<name>", "module name, id, or display name")
  .action(async (name: string) => {
    const data = await readData();
    const nextModules = data.modules.filter((module) => module.displayName !== name);

    if (nextModules.length === data.modules.length) {
      program.error(`No module named '${name}' exists.`);
    }

    data.modules = nextModules;
    await writeData(data);

    console.log(`Deleted module '${name}'.`);
  });

moduleCommand.on("command:*", ([command]) => {
  moduleCommand.error(`Habitat does not know the module command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program.addCommand(moduleCommand);

const blueprintCommand = new Command("blueprint")
  .description("Inspect the cached blueprint catalog.")
  .showHelpAfterError("Try 'habitat blueprint --help' to see blueprint commands.")
  .addHelpText(
    "after",
    `
Schema:
  { blueprintId: string, displayName: string, description?: string, output?: object, inputs?: object, productionCost?: object, requiredFacility?: object, buildTicks?: number, prerequisites?: string[], unlocks?: string[], repeatable?: boolean, level?: number, target?: object, facilityLevel?: object, attachmentPoints?: object, attachmentRequirements?: object[], runtimeAttributes?: object, capabilities?: string[] }

Commands:
  habitat blueprint list
  habitat blueprint show <blueprint-id>

Examples:
  habitat blueprint list
  habitat blueprint show greenhouse

Notes:
  list fetches the live blueprint catalog from Kepler and refreshes the local cache.
  show prints the full local blueprint record.
  blueprint ids are the lookup keys for module creation and catalog inspection.
`,
  );

blueprintCommand
  .command("list")
  .description("List blueprints from Kepler.")
  .action(async () => {
    try {
      const data = await readData();
      const blueprints = await fetchKeplerBlueprintCatalog();

      data.blueprints = blueprints;
      await writeData(data);

      if (blueprints.length === 0) {
        console.log("No blueprints found.");
        return;
      }

      for (const blueprint of blueprints) {
        console.log(`${blueprint.blueprintId} | ${blueprint.displayName}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      program.error(message);
    }
  });

blueprintCommand
  .command("show")
  .description("Show one blueprint.")
  .argument("<blueprint-id>", "blueprint id")
  .action(async (blueprintId: string) => {
    const data = await readData();
    const blueprint = findBlueprint(data, blueprintId);

    if (!blueprint) {
      program.error(`No blueprint with id '${blueprintId}' exists.`);
      throw new Error("Unreachable after Commander exits.");
    }

    console.log(`Blueprint ID: ${blueprint.blueprintId}`);
    console.log(`Display name: ${blueprint.displayName}`);

    if (blueprint.description) {
      console.log(`Description: ${blueprint.description}`);
    }

    if (blueprint.status) {
      console.log(`Status: ${blueprint.status}`);
    }

    if (blueprint.output) {
      console.log(`Output: ${JSON.stringify(blueprint.output, null, 2)}`);
    }

    if (blueprint.inputs) {
      console.log(`Inputs: ${JSON.stringify(blueprint.inputs, null, 2)}`);
    }

    if (blueprint.productionCost) {
      console.log(`Production cost: ${JSON.stringify(blueprint.productionCost, null, 2)}`);
    }

    if (blueprint.requiredFacility) {
      console.log(`Required facility: ${JSON.stringify(blueprint.requiredFacility, null, 2)}`);
    }

    if (typeof blueprint.buildTicks === "number") {
      console.log(`Build ticks: ${blueprint.buildTicks}`);
    }

    if (blueprint.prerequisites && blueprint.prerequisites.length > 0) {
      console.log(`Prerequisites: ${blueprint.prerequisites.join(", ")}`);
    }

    if (blueprint.unlocks && blueprint.unlocks.length > 0) {
      console.log(`Unlocks: ${blueprint.unlocks.join(", ")}`);
    }

    if (typeof blueprint.repeatable === "boolean") {
      console.log(`Repeatable: ${blueprint.repeatable}`);
    }

    if (typeof blueprint.level === "number") {
      console.log(`Level: ${blueprint.level}`);
    }

    if (blueprint.target) {
      console.log(`Target: ${JSON.stringify(blueprint.target, null, 2)}`);
    }

    if (blueprint.facilityLevel) {
      console.log(`Facility level: ${JSON.stringify(blueprint.facilityLevel, null, 2)}`);
    }

    if (blueprint.attachmentPoints) {
      console.log(`Attachment points: ${JSON.stringify(blueprint.attachmentPoints, null, 2)}`);
    }

    if (blueprint.attachmentRequirements && blueprint.attachmentRequirements.length > 0) {
      console.log(`Attachment requirements: ${JSON.stringify(blueprint.attachmentRequirements, null, 2)}`);
    }

    if (blueprint.runtimeAttributes) {
      console.log(`Runtime attributes: ${JSON.stringify(blueprint.runtimeAttributes, null, 2)}`);
    }

    if (blueprint.capabilities && blueprint.capabilities.length > 0) {
      console.log(`Capabilities: ${blueprint.capabilities.join(", ")}`);
    }
  });

blueprintCommand.on("command:*", ([command]) => {
  blueprintCommand.error(`Habitat does not know the blueprint command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program.addCommand(blueprintCommand);

const resourceCommand = new Command("resource")
  .description("Inspect the live resource catalog from Kepler.")
  .showHelpAfterError("Try 'habitat resource --help' to see resource commands.")
  .addHelpText(
    "after",
    `
Schema:
  { resourceId?: string, displayName?: string, name?: string, description?: string, status?: string, capabilities?: string[], runtimeAttributes?: object }

Commands:
  habitat resource list

Examples:
  habitat resource list

Notes:
  list fetches the live resource catalog from Kepler.
  the catalog is not cached in the CLI.
  output shows the resource id and display name.
`,
  );

resourceCommand
  .command("list")
  .description("List resources from Kepler.")
  .action(async () => {
    try {
      const resources: ResourceCatalogEntry[] = await fetchKeplerResourceCatalog();

      if (resources.length === 0) {
        console.log("No resources found.");
        return;
      }

      for (const resource of resources) {
        const resourceId = resource.resourceId ?? resource.id ?? resource.name ?? "unknown";
        const displayName = resource.displayName ?? resource.name ?? resourceId;
        console.log(`${resourceId} | ${displayName}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      program.error(message);
    }
  });

resourceCommand.on("command:*", ([command]) => {
  resourceCommand.error(`Habitat does not know the resource command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program.addCommand(resourceCommand);

const inventoryCommand = new Command("inventory")
  .description("Manage habitat inventory.")
  .showHelpAfterError("Try 'habitat inventory --help' to see inventory commands.")
  .addHelpText(
    "after",
    `
Commands:
  habitat inventory list
  habitat inventory set <resource-id> <amount>

Notes:
  inventory lives in habitat state and is separate from the Kepler resource catalog.
`,
  );

inventoryCommand
  .command("list")
  .description("List inventory.")
  .action(async () => {
    const data = await readData();
    const entries = Object.entries(data.inventory).sort(([left], [right]) => left.localeCompare(right));

    if (entries.length === 0) {
      console.log("No inventory resources found.");
      return;
    }

    for (const [resourceId, amount] of entries) {
      console.log(`${resourceId} | ${amount}`);
    }
  });

inventoryCommand
  .command("set")
  .description("Set an inventory amount.")
  .argument("<resource-id>", "resource id")
  .argument("<amount>", "resource amount", parseInventoryAmount)
  .action(async (resourceId: string, amount: number) => {
    const data = await readData();
    data.inventory[resourceId] = amount;
    await writeData(data);

    console.log(`Set inventory '${resourceId}' to ${amount}.`);
  });

inventoryCommand.on("command:*", ([command]) => {
  inventoryCommand.error(`Habitat does not know the inventory command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program.addCommand(inventoryCommand);

const constructionCommand = new Command("construction")
  .description("Inspect construction jobs.")
  .showHelpAfterError("Try 'habitat construction --help' to see construction commands.")
  .addHelpText(
    "after",
    `
Commands:
  habitat construction list
  habitat construction cancel <job-id>

Notes:
  cancel frees the construction facility but does not refund spent materials.
`,
  );

constructionCommand
  .command("list")
  .description("List construction jobs.")
  .action(async () => {
    const data = await readData();

    if (data.constructionJobs.length === 0) {
      console.log("No construction jobs found.");
      return;
    }

    for (const job of data.constructionJobs) {
      console.log(
        `${job.id} | module: ${slugDisplayName(job.moduleName)} | blueprint: ${job.blueprintId} | facility: ${slugDisplayName(job.facilityModuleName)} | remaining: ${job.remainingBuildTicks}/${job.totalBuildTicks}`,
      );
    }
  });

constructionCommand
  .command("status")
  .description("Show construction jobs.")
  .action(async () => {
    const jobs = await getBackendCommand<ConstructionJob[]>("/commands/construction/status");

    if (jobs.length === 0) {
      console.log("No construction jobs found.");
      return;
    }

    for (const job of jobs) {
      console.log(
        `${job.id} | module: ${slugDisplayName(job.moduleName)} | blueprint: ${job.blueprintId} | facility: ${slugDisplayName(job.facilityModuleName)} | remaining: ${job.remainingBuildTicks}/${job.totalBuildTicks}`,
      );
    }
  });

constructionCommand
  .command("cancel")
  .description("Cancel a construction job.")
  .argument("<job-id>", "construction job id")
  .action(async (jobId: string) => {
    const data = await readData();
    const nextJobs = data.constructionJobs.filter((job) => job.id !== jobId);

    if (nextJobs.length === data.constructionJobs.length) {
      program.error(`No construction job with id '${jobId}' exists.`);
    }

    data.constructionJobs = nextJobs;
    await writeData(data);

    console.log(`Canceled construction job '${jobId}'.`);
  });

constructionCommand.on("command:*", ([command]) => {
  constructionCommand.error(`Habitat does not know the construction command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program.addCommand(constructionCommand);

const debugCommand = new Command("debug")
  .description("Debug-only commands for habitat state.")
  .showHelpAfterError("Try 'habitat debug --help' to see debug commands.")
  .addHelpText(
    "after",
    `
Commands:
  habitat debug construct <blueprint-id>

Notes:
  debug commands are intentionally unsafe and bypass normal habitat readiness checks.
`,
  );

debugCommand
  .command("construct")
  .description("Force create a module from a Kepler blueprint.")
  .argument("<blueprint-id>", "published blueprint id")
  .option("-d, --display-name <displayName>", "visible module display name")
  .addHelpText(
    "after",
    `
This command skips the normal facility, inventory, prerequisite, and power checks.
It still fetches the blueprint from Kepler and stores the created module through the backend.

Examples:
  habitat debug construct greenhouse
`,
  )
  .action(async (blueprintId: string, options: { displayName?: string }) => {
    const data = await readData();
    const blueprints = await fetchKeplerBlueprintCatalog();
    const blueprint = blueprints.find(
      (candidate) => candidate.blueprintId === blueprintId || candidate.id === blueprintId,
    );

    if (!blueprint) {
      program.error(`No blueprint with id '${blueprintId}' exists in Kepler.`);
      throw new Error("Unreachable after Commander exits.");
    }

    const forced = forceConstructionStart({
      blueprint,
      habitat: data,
      displayName: options.displayName ?? blueprint.displayName,
    });

    data.modules.push(
      normalizeModule({
        id: forced.name,
        name: forced.name,
        blueprintId: forced.blueprintId,
        displayName: forced.displayName,
        connectedTo: [],
        runtimeAttributes: {
          ...cloneJson(forced.runtimeAttributes),
          state: "online",
          status: "online",
        },
        capabilities: [...forced.capabilities],
      }),
    );
    data.blueprints = blueprints;
    await writeData(data);

    console.log(`Force created module '${forced.displayName}' from blueprint '${forced.blueprintId}'.`);
  });

debugCommand
  .command("recharge-batteries")
  .description("Recharge all local batteries to full charge.")
  .addHelpText(
    "after",
    `
This command skips normal gameplay constraints and fully recharges every local battery module.

Examples:
  habitat debug recharge-batteries
`,
  )
  .action(async () => {
    const data = await readData();
    let recharged = 0;

    for (const module of data.modules) {
      if (!moduleIsBattery(module)) {
        continue;
      }

      setBatteryCharge(module, BATTERY_MAX_CHARGE);
      recharged += 1;
    }

    await writeData(data);
    console.log(`Recharged ${recharged} batterie(s) to full charge.`);
  });

debugCommand
  .command("battery-drain")
  .description("Show the per-tick construction drain for every local battery.")
  .addHelpText(
    "after",
    `
This command reports the battery multiplier and exact construction drain value used by ticks.

Examples:
  habitat debug battery-drain
`,
  )
  .action(async () => {
    const data = await readData();
    const batteries = data.modules.filter((module) => moduleIsBattery(module));

    if (batteries.length === 0) {
      console.log("No batteries found.");
      return;
    }

    for (const module of batteries) {
      const multiplier = module.runtimeAttributes.chargeLossPerTickMult;
      const drain = batteryConstructionDrainPerTick(module);
      console.log(
        `${module.displayName} | chargeLossPerTickMult: ${typeof multiplier === "number" ? multiplier : 1} | construction drain per tick: ${drain}`,
      );
    }
  });

debugCommand.on("command:*", ([command]) => {
  debugCommand.error(`Habitat does not know the debug command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program.addCommand(debugCommand);

const door = new Command("door")
  .description("Manage doors.")
  .showHelpAfterError("Try 'habitat door --help' to see door commands.")
  .addHelpText(
    "after",
    `
Schema:
  { name: string, airlockName?: string }

Commands:
  habitat door create <name>
  habitat door list
  habitat door show <name>
  habitat door update <name> --name <newName>
  habitat door delete <name>

Relationship:
  Attach a door with: habitat airlock add-door <airlockName> <doorName>
  The relationship is saved on the door as airlockName.

Examples:
  habitat door create outer
  habitat door list
  habitat door show outer
  habitat door update outer --name inner
  habitat airlock add-door main inner
  habitat door delete inner

Notes:
  name is the lookup key for show, update, delete, and add-door.
  doors are stored in backend habitat state.
`,
  );

door
  .command("create")
  .description("Create a door.")
  .argument("<name>", "door name")
  .action(async (name: string) => {
    const data = await readData();

    if (data.doors.some((candidate) => candidate.name === name)) {
      program.error(`A door named '${name}' already exists.`);
    }

    data.doors.push({ name });
    await writeData(data);

    console.log(`Created door '${name}'.`);
  });

door
  .command("list")
  .description("List doors.")
  .action(async () => {
    const data = await readData();

    if (data.doors.length === 0) {
      console.log("No doors found.");
      return;
    }

    for (const door of data.doors) {
      console.log(`${door.name} | airlock: ${door.airlockName ?? "none"}`);
    }
  });

door
  .command("show")
  .description("Show one door.")
  .argument("<name>", "door name")
  .action(async (name: string) => {
    const { door } = await findDoor(name);

    console.log(`Name: ${door.name}`);
    console.log(`Airlock: ${door.airlockName ?? "none"}`);
  });

door
  .command("update")
  .description("Update a door.")
  .argument("<name>", "door name")
  .requiredOption("-n, --name <newName>", "new door name")
  .action(async (name: string, options: { name: string }) => {
    const { data, door } = await findDoor(name);

    if (
      data.doors.some(
        (candidate) => candidate.name !== name && candidate.name === options.name,
      )
    ) {
      program.error(`A door named '${options.name}' already exists.`);
    }

    door.name = options.name;
    await writeData(data);

    console.log(`Updated door '${name}'.`);
  });

door
  .command("delete")
  .description("Delete a door.")
  .argument("<name>", "door name")
  .action(async (name: string) => {
    const data = await readData();
    const nextDoors = data.doors.filter((door) => door.name !== name);

    if (nextDoors.length === data.doors.length) {
      program.error(`No door named '${name}' exists.`);
    }

    data.doors = nextDoors;
    await writeData(data);

    console.log(`Deleted door '${name}'.`);
  });

door.on("command:*", ([command]) => {
  door.error(`Habitat does not know the door command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program.addCommand(door);

await program.parseAsync();
