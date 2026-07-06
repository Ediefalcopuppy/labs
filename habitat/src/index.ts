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

const dataDir = join(process.cwd(), ".habitat");
const zonesPath = join(dataDir, "zones.json");
const airlocksPath = join(dataDir, "airlocks.json");

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const contents = await readFile(path, "utf8");
    const items = JSON.parse(contents) as unknown;

    if (!Array.isArray(items)) {
      throw new Error(`${path} should contain a JSON array.`);
    }

    return items as T[];
  } catch (error) {
    const fileError = error as { code?: string };

    if (error instanceof Error && fileError.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeJsonArray<T>(path: string, items: T[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(items, null, 2)}\n`);
}

async function readZones(): Promise<Zone[]> {
  return readJsonArray<Zone>(zonesPath);
}

async function writeZones(zones: Zone[]): Promise<void> {
  await writeJsonArray(zonesPath, zones);
}

async function findZone(name: string): Promise<{ zones: Zone[]; zone: Zone }> {
  const zones = await readZones();
  const zone = zones.find((candidate) => candidate.name === name);

  if (!zone) {
    program.error(`No zone named '${name}' exists.`);
    throw new Error("Unreachable after Commander exits.");
  }

  return { zones, zone };
}

async function readAirlocks(): Promise<Airlock[]> {
  return readJsonArray<Airlock>(airlocksPath);
}

async function writeAirlocks(airlocks: Airlock[]): Promise<void> {
  await writeJsonArray(airlocksPath, airlocks);
}

async function findAirlock(
  name: string,
): Promise<{ airlocks: Airlock[]; airlock: Airlock }> {
  const airlocks = await readAirlocks();
  const airlock = airlocks.find((candidate) => candidate.name === name);

  if (!airlock) {
    program.error(`No airlock named '${name}' exists.`);
    throw new Error("Unreachable after Commander exits.");
  }

  return { airlocks, airlock };
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
Examples:
  habitat zone create kitchen --purpose cooking --status active
  habitat zone list
  habitat airlock create main --pressure-level 2.5 --locked true
  habitat airlock list

Data:
  Stored in .habitat/ in the current working directory.
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
Examples:
  habitat zone create kitchen --purpose cooking --status active
  habitat zone list
  habitat zone show kitchen
  habitat zone update kitchen --purpose prep --status paused
  habitat zone delete kitchen

Notes:
  update changes only the fields you provide.
`,
  );

zone
  .command("create")
  .description("Create a zone.")
  .argument("<name>", "zone name")
  .requiredOption("-p, --purpose <purpose>", "zone purpose")
  .requiredOption("-s, --status <status>", "zone status")
  .action(async (name: string, options: Pick<Zone, "purpose" | "status">) => {
    const zones = await readZones();

    if (zones.some((candidate) => candidate.name === name)) {
      program.error(`A zone named '${name}' already exists.`);
    }

    zones.push({ name, purpose: options.purpose, status: options.status });
    await writeZones(zones);

    console.log(`Created zone '${name}'.`);
  });

zone
  .command("list")
  .description("List zones.")
  .action(async () => {
    const zones = await readZones();

    if (zones.length === 0) {
      console.log("No zones found.");
      return;
    }

    for (const zone of zones) {
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

    const { zones, zone } = await findZone(name);

    zone.purpose = options.purpose ?? zone.purpose;
    zone.status = options.status ?? zone.status;
    await writeZones(zones);

    console.log(`Updated zone '${name}'.`);
  });

zone
  .command("delete")
  .description("Delete a zone.")
  .argument("<name>", "zone name")
  .action(async (name: string) => {
    const zones = await readZones();
    const nextZones = zones.filter((zone) => zone.name !== name);

    if (nextZones.length === zones.length) {
      program.error(`No zone named '${name}' exists.`);
    }

    await writeZones(nextZones);

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
Examples:
  habitat airlock create main --pressure-level 2.5 --locked true
  habitat airlock list
  habitat airlock show main
  habitat airlock update main --pressure-level 1 --locked false
  habitat airlock delete main

Notes:
  --pressure-level accepts a number.
  --locked accepts true or false.
  update changes only the fields you provide.
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
      const airlocks = await readAirlocks();

      if (airlocks.some((candidate) => candidate.name === name)) {
        program.error(`An airlock named '${name}' already exists.`);
      }

      airlocks.push({
        name,
        pressureLevel: options.pressureLevel,
        locked: options.locked,
      });
      await writeAirlocks(airlocks);

      console.log(`Created airlock '${name}'.`);
    },
  );

airlock
  .command("list")
  .description("List airlocks.")
  .action(async () => {
    const airlocks = await readAirlocks();

    if (airlocks.length === 0) {
      console.log("No airlocks found.");
      return;
    }

    for (const airlock of airlocks) {
      console.log(
        `${airlock.name} | pressure level: ${airlock.pressureLevel} | locked: ${airlock.locked}`,
      );
    }
  });

airlock
  .command("show")
  .description("Show one airlock.")
  .argument("<name>", "airlock name")
  .action(async (name: string) => {
    const { airlock } = await findAirlock(name);

    console.log(`Name: ${airlock.name}`);
    console.log(`Pressure level: ${airlock.pressureLevel}`);
    console.log(`Locked: ${airlock.locked}`);
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

      const { airlocks, airlock } = await findAirlock(name);

      airlock.pressureLevel = options.pressureLevel ?? airlock.pressureLevel;
      airlock.locked = options.locked ?? airlock.locked;
      await writeAirlocks(airlocks);

      console.log(`Updated airlock '${name}'.`);
    },
  );

airlock
  .command("delete")
  .description("Delete an airlock.")
  .argument("<name>", "airlock name")
  .action(async (name: string) => {
    const airlocks = await readAirlocks();
    const nextAirlocks = airlocks.filter((airlock) => airlock.name !== name);

    if (nextAirlocks.length === airlocks.length) {
      program.error(`No airlock named '${name}' exists.`);
    }

    await writeAirlocks(nextAirlocks);

    console.log(`Deleted airlock '${name}'.`);
  });

airlock.on("command:*", ([command]) => {
  airlock.error(`Habitat does not know the airlock command '${command}'.`, {
    code: "commander.unknownCommand",
  });
});

program.addCommand(airlock);

await program.parseAsync();
