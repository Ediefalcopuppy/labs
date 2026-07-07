#!/usr/bin/env bun
import { Command, InvalidArgumentError } from "commander";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Zone = {
  name: string;
  purpose: string;
  status: string;
};

type Airlock = {
  name: string;
  pressureLevel: number;
  locked: boolean;
};

type Door = {
  name: string;
  airlockName?: string;
};

type HabitatPowerTick = {
  powerConsumedTicks: number;
};

type HabitatModule = StarterModuleInstance;

type ModuleState = "online" | "offline" | "idle" | "active" | "damaged";

type StarterModuleInstance = {
  id: string;
  blueprintId: string;
  displayName: string;
  connectedTo: string[];
  runtimeAttributes: Record<string, unknown>;
  capabilities: string[];
};

type ProductionBlueprint = {
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

type HabitatData = {
  zones: Zone[];
  airlocks: Airlock[];
  doors: Door[];
  modules: HabitatModule[];
  blueprints: ProductionBlueprint[];
  power: HabitatPowerTick;
};

const dataDir = join(process.cwd(), ".habitat");
const dataPath = join(dataDir, "data.json");

function createEmptyData(): HabitatData {
  return {
    zones: [],
    airlocks: [],
    doors: [],
    modules: [],
    blueprints: [],
    power: {
      powerConsumedTicks: 0,
    },
  };
}

function normalizeData(data: unknown): HabitatData {
  if (data === null || typeof data !== "object") {
    throw new Error(`${dataPath} should contain a JSON object.`);
  }

  const candidate = data as Partial<HabitatData>;
  const modules = Array.isArray(candidate.modules)
    ? (candidate.modules as HabitatModule[])
    : [];
  const blueprints = Array.isArray(candidate.blueprints)
    ? candidate.blueprints
    : [];

  return {
    zones: Array.isArray(candidate.zones) ? candidate.zones : [],
    airlocks: Array.isArray(candidate.airlocks) ? candidate.airlocks : [],
    doors: Array.isArray(candidate.doors) ? candidate.doors : [],
    modules,
    blueprints,
    power:
      candidate.power && typeof candidate.power === "object"
        ? {
            powerConsumedTicks:
              typeof candidate.power.powerConsumedTicks === "number" &&
              Number.isFinite(candidate.power.powerConsumedTicks)
                ? candidate.power.powerConsumedTicks
                : 0,
          }
        : {
            powerConsumedTicks: 0,
          },
  };
}

async function readData(): Promise<HabitatData> {
  try {
    const contents = await readFile(dataPath, "utf8");
    return normalizeData(JSON.parse(contents) as unknown);
  } catch (error) {
    const fileError = error as { code?: string };

    if (error instanceof Error && fileError.code === "ENOENT") {
      return createEmptyData();
    }

    throw error;
  }
}

async function writeData(data: HabitatData): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeModule(module: HabitatModule): HabitatModule {
  return {
    id: module.id,
    blueprintId: module.blueprintId,
    displayName: module.displayName,
    connectedTo: [...module.connectedTo],
    runtimeAttributes: cloneJson(module.runtimeAttributes),
    capabilities: [...module.capabilities],
  };
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

function sumModulePowerDraw(modules: HabitatModule[]): number {
  return modules.reduce((total, module) => total + moduleCurrentPowerDraw(module), 0);
}

function renderModuleStatusTable(
  rows: Array<{ name: string; state: ModuleState; powerDraw: number }>,
): string {
  const headers = ["Name", "State", "Power Draw"];
  const widths = rows.reduce(
    (accumulator, row) => {
      accumulator[0] = Math.max(accumulator[0], row.name.length, headers[0].length);
      accumulator[1] = Math.max(accumulator[1], row.state.length, headers[1].length);
      accumulator[2] = Math.max(
        accumulator[2],
        String(row.powerDraw).length,
        headers[2].length,
      );
      return accumulator;
    },
    [headers[0].length, headers[1].length, headers[2].length],
  );

  const separator = `${"-".repeat(widths[0])}-+-${"-".repeat(widths[1])}-+-${"-".repeat(widths[2])}`;
  const lines = [
    `${headers[0].padEnd(widths[0])} | ${headers[1].padEnd(widths[1])} | ${headers[2].padStart(widths[2])}`,
    separator,
  ];

  for (const row of rows) {
    lines.push(
      `${row.name.padEnd(widths[0])} | ${row.state.padEnd(widths[1])} | ${String(row.powerDraw).padStart(widths[2])}`,
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
  displayName: string,
): Promise<{ data: HabitatData; module: HabitatModule }> {
  const data = await readData();
  const module = data.modules.find((candidate) => candidate.displayName === displayName);

  if (!module) {
    program.error(`No module named '${displayName}' exists.`);
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
  power:   { powerConsumedTicks: number }

Command map:
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
  habitat module show <name>
  habitat module update <name> [--name <newName>] [--status <status>]
  habitat module delete <name>
  habitat door create <name>
  habitat door list
  habitat door show <name>
  habitat door update <name> --name <newName>
  habitat door delete <name>

Common workflow:
  habitat tick 1
  habitat module list
  habitat module -l
  habitat module status
  habitat module set-status <module-id> <status>
  habitat module create greenhouse --blueprint-id greenhouse
  habitat zone create kitchen --purpose cooking --status active
  habitat airlock create main --pressure-level 2.5 --locked true
  habitat door create outer
  habitat airlock add-door main outer
  habitat airlock show main
  habitat door show outer

Data:
  Stored in .habitat/data.json in the current working directory.
  The file shape is { "zones": [], "airlocks": [], "doors": [], "modules": [], "blueprints": [], "power": { "powerConsumedTicks": 0 } }.
`,
  );

program.on("command:*", ([command]) => {
  program.error(`Habitat does not know the command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program
  .command("tick")
  .description("Advance the habitat simulation by a number of ticks.")
  .argument("<count>", "number of ticks to advance", parseTickCount)
  .addHelpText(
    "after",
    `
For now, tick only updates local power consumption counters.
Each tick increments powerConsumedTicks on every stored module.

Examples:
  habitat tick 1
  habitat tick 12
`,
  )
  .action(async (count: number) => {
    const data = await readData();
    const totalPowerDraw = sumModulePowerDraw(data.modules);

    for (const module of data.modules) {
      const currentPowerTicks = module.runtimeAttributes.powerConsumedTicks;
      const modulePowerDraw = moduleCurrentPowerDraw(module);
      const moduleTickCost = modulePowerDraw * count;
      const nextPowerTicks =
        typeof currentPowerTicks === "number" && Number.isFinite(currentPowerTicks)
          ? currentPowerTicks + moduleTickCost
          : moduleTickCost;

      module.runtimeAttributes = {
        ...module.runtimeAttributes,
        powerConsumedTicks: nextPowerTicks,
      };
    }

    data.power.powerConsumedTicks += totalPowerDraw * count;
    await writeData(data);

    console.log(`Advanced habitat by ${count} tick(s).`);
    console.log(`Updated power consumption counters on ${data.modules.length} module(s).`);
    console.log(`Energy cost for ${count} tick(s): ${totalPowerDraw * count}`);
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
  zones are stored in the zones array in .habitat/data.json.
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
  airlocks are stored in the airlocks array in .habitat/data.json.
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
  habitat module show <name>
  habitat module update <name> [--name <newName>] [--status <status>]
  habitat module delete <name>

Notes:
  name is the lookup key and displayName for local modules.
  create is blueprint-driven and uses the cached blueprint catalog.
  -l lists the cached blueprint ids and display names.
  update changes the display name and/or runtime status.
  status reads runtimeAttributes.state first, then runtimeAttributes.status.
  power draw prefers runtimeAttributes.powerDrawByState, then state-specific power draw fields, then runtimeAttributes.powerDraw.
  set-status changes only runtimeAttributes.status on the matching module id.
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
  .description("Create a module from a cached blueprint.")
  .argument("<name>", "module display name")
  .requiredOption("-b, --blueprint-id <blueprintId>", "published blueprint id")
  .addHelpText(
    "after",
    `
The blueprint must exist in the cached blueprint catalog and must output a module.
`,
  )
  .action(async (name: string, options: { blueprintId: string }) => {
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

    if (data.modules.some((candidate) => candidate.displayName === name)) {
      program.error(`A module named '${name}' already exists.`);
    }

    data.modules.push(
      normalizeModule({
        id: `module_${randomUUID()}`,
        blueprintId: blueprint.blueprintId,
        displayName: name,
        connectedTo: [],
        runtimeAttributes: cloneJson(blueprint.runtimeAttributes ?? {}),
        capabilities: [...(blueprint.capabilities ?? [])],
      }),
    );
    await writeData(data);

    console.log(`Created module '${name}'.`);
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
        `${slugDisplayName(module.displayName)} | blueprint: ${module.blueprintId} | status: ${moduleStatus(module)} | capabilities: ${module.capabilities.join(", ")}`,
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
  .command("show")
  .description("Show one module.")
  .argument("<name>", "module display name")
  .action(async (name: string) => {
    const { module } = await findModule(name);

    console.log(`Name: ${slugDisplayName(module.displayName)}`);
    console.log(`ID: ${module.id}`);
    console.log(`Blueprint: ${module.blueprintId}`);
    console.log(`Status: ${moduleStatus(module)}`);
    console.log(`Connected to: ${module.connectedTo.length > 0 ? module.connectedTo.join(", ") : "none"}`);
    console.log(`Capabilities: ${module.capabilities.length > 0 ? module.capabilities.join(", ") : "none"}`);
    console.log(`Runtime attributes: ${JSON.stringify(module.runtimeAttributes, null, 2)}`);
  });

moduleCommand
  .command("update")
  .description("Update a module.")
  .argument("<name>", "module display name")
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
  .argument("<name>", "module display name")
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
  doors are stored in the doors array in .habitat/data.json.
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
