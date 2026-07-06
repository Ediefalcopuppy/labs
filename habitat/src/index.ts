#!/usr/bin/env bun
import { Command, InvalidArgumentError } from "commander";
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

type HabitatData = {
  zones: Zone[];
  airlocks: Airlock[];
  doors: Door[];
};

const dataDir = join(process.cwd(), ".habitat");
const dataPath = join(dataDir, "data.json");

function createEmptyData(): HabitatData {
  return {
    zones: [],
    airlocks: [],
    doors: [],
  };
}

function normalizeData(data: unknown): HabitatData {
  if (data === null || typeof data !== "object") {
    throw new Error(`${dataPath} should contain a JSON object.`);
  }

  const candidate = data as Partial<HabitatData>;

  return {
    zones: Array.isArray(candidate.zones) ? candidate.zones : [],
    airlocks: Array.isArray(candidate.airlocks) ? candidate.airlocks : [],
    doors: Array.isArray(candidate.doors) ? candidate.doors : [],
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

Command map:
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
  habitat door create <name>
  habitat door list
  habitat door show <name>
  habitat door update <name> --name <newName>
  habitat door delete <name>

Common workflow:
  habitat zone create kitchen --purpose cooking --status active
  habitat airlock create main --pressure-level 2.5 --locked true
  habitat door create outer
  habitat airlock add-door main outer
  habitat airlock show main
  habitat door show outer

Data:
  Stored in .habitat/data.json in the current working directory.
  The file shape is { "zones": [], "airlocks": [], "doors": [] }.
`,
  );

program.on("command:*", ([command]) => {
  program.error(`Habitat does not know the command '${command}'.`, {
    code: "commander.unknownCommand",
  });
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
      const doorCount = data.doors.filter((door) => door.airlockName === airlock.name).length;
      console.log(
        `${airlock.name} | pressure level: ${airlock.pressureLevel} | locked: ${airlock.locked} | doors: ${doorCount}`,
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
