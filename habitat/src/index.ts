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

type HabitatModule = StarterModuleInstance;

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

type KeplerHabitat = {
  id: string;
  habitatSlug: string;
  displayName: string;
  catalogVersion: string;
  status: string;
  lastSeenAt?: string | null;
};

type KeplerRegistration = {
  habitatUuid: string;
  displayName: string;
  habitatId: string;
  planetBaseUrl: string;
  habitat?: KeplerHabitat;
  registeredAt: string;
  lastSyncedAt: string;
};

type HabitatData = {
  zones: Zone[];
  airlocks: Airlock[];
  doors: Door[];
  modules: HabitatModule[];
  blueprints: ProductionBlueprint[];
  registration?: KeplerRegistration;
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
  };
}

function normalizeData(data: unknown): HabitatData {
  if (data === null || typeof data !== "object") {
    throw new Error(`${dataPath} should contain a JSON object.`);
  }

  const candidate = data as Partial<HabitatData>;
  const legacyRegistration = candidate.registration as
    | (Partial<KeplerRegistration> & {
        starterModules?: unknown;
        blueprints?: unknown;
      })
    | undefined;
  const modules = Array.isArray(candidate.modules)
    ? (candidate.modules as HabitatModule[])
    : Array.isArray(legacyRegistration?.starterModules)
      ? (legacyRegistration.starterModules as HabitatModule[])
      : [];
  const blueprints = Array.isArray(candidate.blueprints)
    ? candidate.blueprints
    : Array.isArray(legacyRegistration?.blueprints)
      ? (legacyRegistration.blueprints as ProductionBlueprint[])
      : [];

  return {
    zones: Array.isArray(candidate.zones) ? candidate.zones : [],
    airlocks: Array.isArray(candidate.airlocks) ? candidate.airlocks : [],
    doors: Array.isArray(candidate.doors) ? candidate.doors : [],
    modules,
    blueprints,
    registration:
      candidate.registration && typeof candidate.registration === "object"
        ? (candidate.registration as KeplerRegistration)
        : undefined,
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
  const status = module.runtimeAttributes.status;
  return typeof status === "string" ? status : "unknown";
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

function getPlanetBaseUrl(): string {
  return (
    process.env.KEPLER_PLANET_BASE_URL ??
    process.env.KEPLER_WORLD_BASE_URL ??
    process.env.PLANET_SERVER_PUBLIC_BASE_URL ??
    "https://planet.turingguild.com"
  ).replace(/\/+$/, "");
}

function getPlanetToken(): string {
  const token =
    process.env.KEPLER_PLANET_TOKEN ??
    process.env.KEPLER_WORLD_TOKEN ??
    process.env.PLANET_TOKEN;

  if (!token) {
    program.error(
      "Missing Kepler bearer token. Set KEPLER_PLANET_TOKEN, KEPLER_WORLD_TOKEN, or PLANET_TOKEN.",
    );
    throw new Error("Unreachable after Commander exits.");
  }

  return token;
}

async function requestKepler<T>(
  path: string,
  options: {
    method: "GET" | "POST" | "DELETE";
    body?: unknown;
    baseUrl?: string;
  },
): Promise<T | undefined> {
  const baseUrl = options.baseUrl ?? getPlanetBaseUrl();
  const headers = new Headers({
    Authorization: `Bearer ${getPlanetToken()}`,
  });

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;

  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    program.error(`Could not reach Kepler at ${baseUrl}: ${message}`);
    throw new Error("Unreachable after Commander exits.");
  }

  if (!response.ok) {
    const errorText = await response.text();
    program.error(
      `Kepler request failed: ${options.method} ${path} returned ${response.status}${errorText ? `: ${errorText}` : ""}`,
    );
    throw new Error("Unreachable after Commander exits.");
  }

  if (response.status === 204) {
    return undefined;
  }

  return (await response.json()) as T;
}

type HabitatRegistrationResponse = {
  habitatId: string;
  starterModules: StarterModuleInstance[];
  blueprints: ProductionBlueprint[];
};

type HabitatResponse = {
  habitat: KeplerHabitat;
};

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

Command map:
  habitat register --name <habitat name>
  habitat status
  habitat unregister
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
  habitat module list
  habitat module show <name>
  habitat module update <name> [--name <newName>] [--status <status>]
  habitat module delete <name>
  habitat door create <name>
  habitat door list
  habitat door show <name>
  habitat door update <name> --name <newName>
  habitat door delete <name>

Common workflow:
  habitat register --name "Artemis Ridge"
  habitat status
  habitat module list
  habitat module create greenhouse --blueprint-id greenhouse
  habitat zone create kitchen --purpose cooking --status active
  habitat airlock create main --pressure-level 2.5 --locked true
  habitat door create outer
  habitat airlock add-door main outer
  habitat airlock show main
  habitat door show outer

Data:
  Stored in .habitat/data.json in the current working directory.
  The file shape is { "zones": [], "airlocks": [], "doors": [], "modules": [], "blueprints": [], "registration": {} }.
  Kepler tokens are read from env and are never stored in this file.

Kepler auth:
  Set KEPLER_PLANET_TOKEN, KEPLER_WORLD_TOKEN, or PLANET_TOKEN.
  Optional base URL env: KEPLER_PLANET_BASE_URL, KEPLER_WORLD_BASE_URL, or PLANET_SERVER_PUBLIC_BASE_URL.
`,
  );

program.on("command:*", ([command]) => {
  program.error(`Habitat does not know the command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program
  .command("register")
  .description("Register this habitat with Kepler.")
  .requiredOption("-n, --name <habitatName>", "habitat display name")
  .addHelpText(
    "after",
    `
Sends exactly these OpenAPI request keys:
  { "displayName": string, "habitatUuid": uuid }

Hydrates local module records from returned starterModules and caches the returned blueprints locally.
`,
  )
  .action(async (options: { name: string }) => {
    const data = await readData();

    if (data.registration) {
      program.error(
        `This directory is already registered as '${data.registration.displayName}' (${data.registration.habitatId}).`,
      );
    }

    const planetBaseUrl = getPlanetBaseUrl();
    const habitatUuid = randomUUID();
    const now = new Date().toISOString();
    const response = await requestKepler<HabitatRegistrationResponse>(
      "/habitats/register",
      {
        method: "POST",
        baseUrl: planetBaseUrl,
        body: {
          displayName: options.name,
          habitatUuid,
        },
      },
    );

    if (!response) {
      program.error("Kepler did not return registration data.");
      throw new Error("Unreachable after Commander exits.");
    }

    data.modules = response.starterModules.map(normalizeModule);
    data.blueprints = cloneJson(response.blueprints);
    data.registration = {
      habitatUuid,
      displayName: options.name,
      habitatId: response.habitatId,
      planetBaseUrl,
      registeredAt: now,
      lastSyncedAt: now,
    };
    await writeData(data);

    console.log(`Registered habitat '${options.name}'.`);
    console.log(`Habitat ID: ${response.habitatId}`);
    console.log(`Starter modules: ${data.modules.length}`);
    console.log(`Blueprints: ${data.blueprints.length}`);
  });

program
  .command("status")
  .description("Show Kepler registration status for this habitat.")
  .addHelpText(
    "after",
    `
Requires an existing local registration from habitat register.
Fetches GET /habitats/{habitatId}/registration and updates local registration metadata.
`,
  )
  .action(async () => {
    const data = await readData();

    if (!data.registration) {
      console.log("Not registered with Kepler.");
      return;
    }

    const response = await requestKepler<HabitatResponse>(
      `/habitats/${encodeURIComponent(data.registration.habitatId)}/registration`,
      {
        method: "GET",
        baseUrl: data.registration.planetBaseUrl,
      },
    );

    if (!response) {
      program.error("Kepler did not return habitat status data.");
      throw new Error("Unreachable after Commander exits.");
    }

    data.registration.habitat = response.habitat;
    data.registration.lastSyncedAt = new Date().toISOString();
    await writeData(data);

    console.log(`Registration: registered`);
    console.log(`Display name: ${response.habitat.displayName}`);
    console.log(`Habitat ID: ${response.habitat.id}`);
    console.log(`Slug: ${response.habitat.habitatSlug}`);
    console.log(`Status: ${response.habitat.status}`);
    console.log(`Catalog version: ${response.habitat.catalogVersion}`);
    console.log(`Last seen: ${response.habitat.lastSeenAt ?? "never"}`);
    console.log(`Base URL: ${data.registration.planetBaseUrl}`);
    console.log(`Modules: ${data.modules.length}`);
  });

program
  .command("unregister")
  .description("Delete this habitat registration from Kepler.")
  .addHelpText(
    "after",
    `
Sends DELETE /habitats/{habitatId}.
On 204 success, clears only the local Kepler registration metadata.
Local zones, airlocks, doors, modules, and blueprints remain in .habitat/data.json.
`,
  )
  .action(async () => {
    const data = await readData();

    if (!data.registration) {
      console.log("Not registered with Kepler.");
      return;
    }

    const { habitatId, displayName, planetBaseUrl } = data.registration;

    await requestKepler<void>(`/habitats/${encodeURIComponent(habitatId)}`, {
      method: "DELETE",
      baseUrl: planetBaseUrl,
    });

    delete data.registration;
    await writeData(data);

    console.log(`Unregistered habitat '${displayName}'.`);
    console.log(`Habitat ID: ${habitatId}`);
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
  habitat module list
  habitat module show <name>
  habitat module update <name> [--name <newName>] [--status <status>]
  habitat module delete <name>

Notes:
  name is the lookup key and displayName for local modules.
  create is blueprint-driven and uses the cached Kepler blueprint catalog.
  starter modules are hydrated automatically during habitat register.
  update changes the display name and/or runtime status.
`,
  );

moduleCommand
  .command("create")
  .description("Create a module from a cached Kepler blueprint.")
  .argument("<name>", "module display name")
  .requiredOption("-b, --blueprint-id <blueprintId>", "published blueprint id")
  .addHelpText(
    "after",
    `
The blueprint must exist in the cached Kepler blueprint catalog and must output a module.
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
