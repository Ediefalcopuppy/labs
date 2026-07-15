import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Hono } from "hono";
import { batteryConstructionDrainPerTick, BATTERY_MAX_CHARGE } from "../construction";
import { runConstructCommand, runDebugConstructCommand, runInventorySetCommand, runModuleSetStatusCommand, runTickCommand } from "../domain/commands";
import { spendInventoryMaterials } from "../domain/inventory";
import { normalizeModuleNames } from "../domain/modules";
import { readJsonFile, writeSqliteState } from "../storage";
import { fetchKeplerBlueprintCatalog, fetchKeplerHabitatRegistration, fetchKeplerResourceCatalog, fetchKeplerSolarIrradiance, fetchKeplerWorldScan } from "../kepler/service";
import { registerHealthRoute } from "./health";
import { createStateService, type StateService, normalizeState } from "../state/service";

const defaultStateService = createStateService({ storagePath: ".habitat/habitat.sqlite" });

function requireItem<T>(items: T[], predicate: (item: T) => boolean, message: string): T {
  const found = items.find(predicate);
  if (!found) throw new Error(message);
  return found;
}

function moduleCurrentState(module: { runtimeAttributes: Record<string, unknown> }): string {
  const candidate = module.runtimeAttributes.state ?? module.runtimeAttributes.status;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : "offline";
}

function isCharger(module: { capabilities: string[]; runtimeAttributes: Record<string, unknown> }): boolean {
  return module.capabilities.includes("isCharger") || module.runtimeAttributes.isCharger === true;
}

function isBattery(module: { capabilities: string[]; runtimeAttributes: Record<string, unknown>; blueprintId: string }): boolean {
  return (
    module.capabilities.includes("isBattery") ||
    module.runtimeAttributes.isBattery === true ||
    module.blueprintId === "battery-bank"
  );
}

function parseFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number.`);
  }
  return value;
}

function parseIntegerInRange(value: unknown, fieldName: string, min: number, max: number): number {
  const parsed = parseFiniteNumber(value, fieldName);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${fieldName} must be an integer.`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${fieldName} must be between ${min} and ${max}.`);
  }
  return parsed;
}

export function createApp(stateService: StateService = defaultStateService): Hono {
  const app = new Hono();
  registerHealthRoute(app);
  app.onError((error, c) => {
    console.error(`[error] ${c.req.method} ${new URL(c.req.url).pathname}: ${error.message}`);
    return c.json({ error: "Habitat request failed", message: error.message }, 500);
  });
  app.use("*", async (c, next) => {
    const startedAt = Date.now();
    console.log(`[request] ${c.req.method} ${new URL(c.req.url).pathname}`);
    await next();
    console.log(`[response] ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - startedAt}ms`);
  });

  app.get("/state", async (c) => c.json(await stateService.getState()));
  app.post("/state", async (c) => {
    console.log("[action] save habitat state");
    return c.json(await stateService.saveState(await c.req.json()));
  });
  app.delete("/state", async (c) => {
    console.log("[action] reset habitat state");
    return c.json(await stateService.resetState());
  });

  app.get("/kepler/blueprints", async (c) => c.json(await fetchKeplerBlueprintCatalog()));
  app.get("/kepler/resources", async (c) => c.json(await fetchKeplerResourceCatalog()));
  app.get("/kepler/solar", async (c) => c.json({ irradiance: await fetchKeplerSolarIrradiance() }));
  app.get("/kepler/habitats/:habitatId/registration", async (c) => c.json(await fetchKeplerHabitatRegistration(c.req.param("habitatId"))));

  app.post("/commands/register", async (c) => {
    console.log("[action] register habitat");
    const { name } = (await c.req.json()) as { name: string };
    const data = await stateService.getState();
    if (data.registration) throw new Error(`This directory is already registered as '${data.registration.displayName}'.`);
    const now = new Date().toISOString();
    data.registration = { displayName: name, registeredAt: now, lastSyncedAt: now };
    return c.json(await stateService.saveState(data));
  });
  app.post("/commands/link", async (c) => {
    console.log("[action] link habitat");
    const { id } = (await c.req.json()) as { id: string };
    const data = await stateService.getState();
    if (data.registration) throw new Error(`This directory is already registered as '${data.registration.displayName}'.`);
    const habitat = await fetchKeplerHabitatRegistration(id);
    const now = new Date().toISOString();
    data.registration = { displayName: habitat.displayName, registeredAt: now, lastSyncedAt: now, habitatId: habitat.id, habitatSlug: habitat.habitatSlug, catalogVersion: habitat.catalogVersion, remoteStatus: habitat.status, lastSeenAt: habitat.lastSeenAt ?? null };
    return c.json(await stateService.saveState(data));
  });
  app.delete("/commands/unregister", async (c) => {
    console.log("[action] unregister habitat");
    const data = await stateService.getState();
    const displayName = data.registration?.displayName;
    delete data.registration;
    await stateService.saveState(data);
    return c.json({ displayName });
  });
  app.get("/commands/status", async (c) => c.json(await stateService.getState()));
  app.get("/commands/power/overview", async (c) => {
    console.log("[action] compute power overview");
    const data = await stateService.getState();
    const moduleStates = data.modules.reduce<Record<string, number>>(
      (counts, module) => {
        const state = moduleCurrentState(module);
        counts[state] = (counts[state] ?? 0) + 1;
        return counts;
      },
      {},
    );
    const totalPowerDraw = data.modules.reduce((sum, module) => {
      const candidate = module.runtimeAttributes.powerDraw;
      return sum + (typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0);
    }, 0);
    return c.json({
      registered: Boolean(data.registration),
      moduleStates,
      totalPowerDraw,
      powerConsumedTicks: data.power.powerConsumedTicks,
      moduleCount: data.modules.length,
      constructionJobs: data.constructionJobs.length,
    });
  });
  app.get("/commands/solar/status", async (c) => {
    console.log("[action] inspect solar status");
    const data = await stateService.getState();
    const irradiance = await fetchKeplerSolarIrradiance();
    const chargers = data.modules.filter((module) => moduleCurrentState(module) === "online" && isCharger(module));
    return c.json({ irradiance, chargers: chargers.length, totalChargePerTick: chargers.length });
  });

  app.get("/commands/blueprint/list", async (c) => {
    console.log("[action] refresh blueprint catalog");
    const blueprints = await fetchKeplerBlueprintCatalog();
    const data = await stateService.getState();
    data.blueprints = blueprints;
    await stateService.saveState(data);
    return c.json(blueprints);
  });
  app.get("/commands/blueprint/:blueprintId", async (c) => {
    console.log(`[action] show blueprint ${c.req.param("blueprintId")}`);
    const data = await stateService.getState();
    const blueprint = data.blueprints.find((candidate) => candidate.blueprintId === c.req.param("blueprintId"));
    if (!blueprint) throw new Error(`No blueprint with id '${c.req.param("blueprintId")}' exists.`);
    return c.json(blueprint);
  });
  app.get("/commands/resource/list", async (c) => {
    console.log("[action] list resources");
    return c.json(await fetchKeplerResourceCatalog());
  });
  app.post("/commands/resource/scan", async (c) => {
    console.log("[action] scan resources");
    const body = (await c.req.json()) as {
      x: unknown;
      y: unknown;
      sensorStrength: unknown;
      radiusTiles?: unknown;
      radius?: unknown;
    };
    const registration = (await stateService.getState()).registration;
    if (!registration?.habitatId) {
      throw new Error("Habitat registration must include a habitatId before resource scanning.");
    }

    const scan = await fetchKeplerWorldScan({
      habitatId: registration.habitatId,
      x: parseIntegerInRange(body.x, "x", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      y: parseIntegerInRange(body.y, "y", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      sensorStrength: parseIntegerInRange(body.sensorStrength, "sensorStrength", 0, 100),
      radiusTiles: parseIntegerInRange(body.radiusTiles ?? body.radius ?? 0, "radiusTiles", 0, 5),
    });

    return c.json(scan);
  });

  app.get("/commands/inventory/list", async (c) => c.json((await stateService.getState()).inventory));
  app.post("/commands/inventory/set", async (c) => {
    console.log("[action] set inventory");
    return c.json(await runInventorySetCommand({ stateService, ...(await c.req.json()) as { resourceId: string; amount: number } }));
  });
  app.get("/commands/construction/list", async (c) => c.json((await stateService.getState()).constructionJobs));
  app.get("/commands/construction/status", async (c) => c.json((await stateService.getState()).constructionJobs));
  app.delete("/commands/construction/:jobId", async (c) => {
    console.log(`[action] cancel construction ${c.req.param("jobId")}`);
    const data = await stateService.getState();
    data.constructionJobs = data.constructionJobs.filter((job) => job.id !== c.req.param("jobId"));
    return c.json(await stateService.saveState(data));
  });

  app.post("/commands/construct", async (c) => {
    console.log("[action] construct from blueprint");
    return c.json(await runConstructCommand({ stateService, ...(await c.req.json()) as { blueprintId: string; displayName?: string; moduleName?: string } }));
  });
  app.post("/commands/debug/construct", async (c) => {
    console.log("[action] force construct from blueprint");
    return c.json(await runDebugConstructCommand({ stateService, ...(await c.req.json()) as { blueprintId: string; displayName?: string; moduleName?: string } }));
  });
  app.post("/commands/module/create", async (c) => {
    console.log("[action] create module from blueprint");
    return c.json(await runConstructCommand({ stateService, ...(await c.req.json()) as { blueprintId: string; displayName?: string; moduleName?: string } }));
  });
  app.post("/commands/module/set-status", async (c) => {
    console.log("[action] set module status");
    return c.json(await runModuleSetStatusCommand({ stateService, ...(await c.req.json()) as { moduleId: string; status: string } }));
  });
  app.post("/commands/tick", async (c) => {
    const { count } = (await c.req.json()) as { count: number };
    console.log(`[action] tick ${count}`);
    return c.json(await runTickCommand({ stateService, count } as any));
  });

  app.post("/commands/zone/create", async (c) => {
    console.log("[action] create zone");
    const { name, purpose, status } = (await c.req.json()) as { name: string; purpose: string; status: string };
    const data = await stateService.getState();
    if (data.zones.some((zone) => zone.name === name)) throw new Error(`A zone named '${name}' already exists.`);
    data.zones.push({ name, purpose, status });
    return c.json(await stateService.saveState(data));
  });
  app.get("/commands/zone/list", async (c) => c.json((await stateService.getState()).zones));
  app.get("/commands/zone/:name", async (c) => c.json(requireItem((await stateService.getState()).zones, (z) => z.name === c.req.param("name"), `No zone named '${c.req.param("name")}' exists.`)));
  app.post("/commands/zone/:name", async (c) => {
    console.log(`[action] update zone ${c.req.param("name")}`);
    const body = (await c.req.json()) as { purpose?: string; status?: string };
    const data = await stateService.getState();
    const zone = requireItem(data.zones, (z) => z.name === c.req.param("name"), `No zone named '${c.req.param("name")}' exists.`);
    if (body.purpose !== undefined) zone.purpose = body.purpose;
    if (body.status !== undefined) zone.status = body.status;
    return c.json(await stateService.saveState(data));
  });
  app.delete("/commands/zone/:name", async (c) => {
    console.log(`[action] delete zone ${c.req.param("name")}`);
    const data = await stateService.getState();
    data.zones = data.zones.filter((zone) => zone.name !== c.req.param("name"));
    return c.json(await stateService.saveState(data));
  });

  app.post("/commands/airlock/create", async (c) => {
    console.log("[action] create airlock");
    const body = (await c.req.json()) as { name: string; pressureLevel: number; locked: boolean };
    const data = await stateService.getState();
    if (data.airlocks.some((airlock) => airlock.name === body.name)) throw new Error(`An airlock named '${body.name}' already exists.`);
    data.airlocks.push(body);
    return c.json(await stateService.saveState(data));
  });
  app.get("/commands/airlock/list", async (c) => c.json((await stateService.getState()).airlocks));
  app.get("/commands/airlock/:name", async (c) => c.json(requireItem((await stateService.getState()).airlocks, (a) => a.name === c.req.param("name"), `No airlock named '${c.req.param("name")}' exists.`)));
  app.post("/commands/airlock/:name", async (c) => {
    console.log(`[action] update airlock ${c.req.param("name")}`);
    const body = (await c.req.json()) as { pressureLevel?: number; locked?: boolean };
    const data = await stateService.getState();
    const airlock = requireItem(data.airlocks, (a) => a.name === c.req.param("name"), `No airlock named '${c.req.param("name")}' exists.`);
    if (body.pressureLevel !== undefined) airlock.pressureLevel = body.pressureLevel;
    if (body.locked !== undefined) airlock.locked = body.locked;
    return c.json(await stateService.saveState(data));
  });
  app.delete("/commands/airlock/:name", async (c) => {
    console.log(`[action] delete airlock ${c.req.param("name")}`);
    const data = await stateService.getState();
    const name = c.req.param("name");
    data.airlocks = data.airlocks.filter((airlock) => airlock.name !== name);
    for (const door of data.doors) if (door.airlockName === name) delete door.airlockName;
    return c.json(await stateService.saveState(data));
  });
  app.post("/commands/airlock/:name/add-door", async (c) => {
    console.log(`[action] attach door to airlock ${c.req.param("name")}`);
    const { doorName } = (await c.req.json()) as { doorName: string };
    const data = await stateService.getState();
    const airlock = requireItem(data.airlocks, (a) => a.name === c.req.param("name"), `No airlock named '${c.req.param("name")}' exists.`);
    const door = requireItem(data.doors, (d) => d.name === doorName, `No door named '${doorName}' exists.`);
    door.airlockName = airlock.name;
    return c.json(await stateService.saveState(data));
  });

  app.post("/commands/door/create", async (c) => {
    console.log("[action] create door");
    const { name } = (await c.req.json()) as { name: string };
    const data = await stateService.getState();
    if (data.doors.some((door) => door.name === name)) throw new Error(`A door named '${name}' already exists.`);
    data.doors.push({ name });
    return c.json(await stateService.saveState(data));
  });
  app.get("/commands/door/list", async (c) => c.json((await stateService.getState()).doors));
  app.get("/commands/door/:name", async (c) => c.json(requireItem((await stateService.getState()).doors, (d) => d.name === c.req.param("name"), `No door named '${c.req.param("name")}' exists.`)));
  app.post("/commands/door/:name", async (c) => {
    console.log(`[action] update door ${c.req.param("name")}`);
    const { name } = (await c.req.json()) as { name: string };
    const data = await stateService.getState();
    const door = requireItem(data.doors, (d) => d.name === c.req.param("name"), `No door named '${c.req.param("name")}' exists.`);
    door.name = name;
    return c.json(await stateService.saveState(data));
  });
  app.delete("/commands/door/:name", async (c) => {
    console.log(`[action] delete door ${c.req.param("name")}`);
    const data = await stateService.getState();
    const next = data.doors.filter((door) => door.name !== c.req.param("name"));
    if (next.length === data.doors.length) throw new Error(`No door named '${c.req.param("name")}' exists.`);
    data.doors = next;
    return c.json(await stateService.saveState(data));
  });

  app.get("/commands/module/list", async (c) => c.json((await stateService.getState()).modules));
  app.get("/commands/module/status", async (c) => c.json((await stateService.getState()).modules));
  app.post("/commands/module/normalize-names", async (c) => {
    console.log("[action] normalize module names");
    const data = await stateService.getState();
    data.modules = normalizeModuleNames(data.modules);
    const moduleIds = new Map(data.modules.map((module) => [module.id, module.name]));
    data.modules = data.modules.map((module) => ({ ...module, id: module.name, connectedTo: module.connectedTo.map((id) => moduleIds.get(id) ?? id) }));
    data.constructionJobs = data.constructionJobs.map((job) => ({ ...job, facilityModuleId: moduleIds.get(job.facilityModuleId) ?? job.facilityModuleId }));
    return c.json(await stateService.saveState(data));
  });
  app.post("/commands/module/create", async (c) => c.json(await runConstructCommand({ stateService, ...(await c.req.json()) as any })));
  app.get("/commands/module/:name", async (c) => c.json(requireItem((await stateService.getState()).modules, (m) => m.name === c.req.param("name") || m.id === c.req.param("name") || m.displayName === c.req.param("name"), `No module named '${c.req.param("name")}' exists.`)));
  app.post("/commands/module/:name", async (c) => {
    console.log(`[action] update module ${c.req.param("name")}`);
    const body = (await c.req.json()) as { name?: string; status?: string };
    const data = await stateService.getState();
    const module = requireItem(data.modules, (m) => m.name === c.req.param("name") || m.id === c.req.param("name") || m.displayName === c.req.param("name"), `No module named '${c.req.param("name")}' exists.`);
    if (body.name !== undefined) module.displayName = body.name;
    if (body.status !== undefined) module.runtimeAttributes = { ...module.runtimeAttributes, state: body.status, status: body.status };
    return c.json(await stateService.saveState(data));
  });
  app.delete("/commands/module/:name", async (c) => {
    console.log(`[action] delete module ${c.req.param("name")}`);
    const data = await stateService.getState();
    const name = c.req.param("name");
    const next = data.modules.filter((module) => module.id !== name && module.name !== name && module.displayName !== name);
    if (next.length === data.modules.length) throw new Error(`No module named '${name}' exists.`);
    data.modules = next;
    return c.json(await stateService.saveState(data));
  });

  app.get("/commands/debug/battery-drain", async (c) => {
    console.log("[action] inspect battery drain");
    const data = await stateService.getState();
    return c.json(data.modules.filter((module) => isBattery(module as never)).map((module) => ({ name: module.displayName, chargeLossPerTickMult: typeof module.runtimeAttributes.chargeLossPerTickMult === "number" ? module.runtimeAttributes.chargeLossPerTickMult : 1, drain: batteryConstructionDrainPerTick(module as never) })));
  });
  app.post("/commands/debug/recharge-batteries", async (c) => {
    console.log("[action] recharge batteries");
    const data = await stateService.getState();
    let count = 0;
    for (const module of data.modules) {
      if (isBattery(module as never)) {
        module.runtimeAttributes.currentEnergyKwh = BATTERY_MAX_CHARGE;
        module.runtimeAttributes.charge = BATTERY_MAX_CHARGE;
        count += 1;
      }
    }
    await stateService.saveState(data);
    return c.json({ count });
  });

  app.post("/commands/storage/sqlite", async (c) => {
    const state = await stateService.getState();
    await writeSqliteState(join(process.cwd(), ".habitat", "habitat.sqlite"), state);
    return c.json({ restored: false, message: "SQLite state rebuilt from the current habitat state." });
  });
  app.post("/commands/storage/restore", async (c) => {
    const backupPath = join(process.cwd(), ".habitat", "data.json.backup");
    const backup = await readJsonFile(backupPath);
    return c.json(await stateService.saveState(normalizeState(backup)));
  });

  // Serve the Vite production bundle when it exists. API routes above remain the source of truth.
  app.get("/*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const assetPath = pathname === "/" || !pathname.includes(".")
      ? join(process.cwd(), "web", "dist", "index.html")
      : join(process.cwd(), "web", "dist", pathname.slice(1));
    const file = Bun.file(assetPath);
    if (await file.exists()) return new Response(file);
    return c.notFound();
  });

  return app;
}
