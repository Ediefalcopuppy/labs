import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { batteryConstructionDrainPerTick, BATTERY_MAX_CHARGE } from "../construction";
import { runConstructCommand, runInventorySetCommand, runModuleSetStatusCommand, runTickCommand } from "../domain/commands";
import { spendInventoryMaterials } from "../domain/inventory";
import { normalizeModuleNames } from "../domain/modules";
import { fetchKeplerBlueprintCatalog, fetchKeplerHabitatRegistration, fetchKeplerResourceCatalog, fetchKeplerSolarIrradiance } from "../kepler/service";
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

export function createApp(stateService: StateService = defaultStateService): Hono {
  const app = new Hono();
  registerHealthRoute(app);

  app.get("/state", async (c) => c.json(await stateService.getState()));
  app.post("/state", async (c) => c.json(await stateService.saveState(await c.req.json())));
  app.delete("/state", async (c) => c.json(await stateService.resetState()));

  app.get("/kepler/blueprints", async (c) => c.json(await fetchKeplerBlueprintCatalog()));
  app.get("/kepler/resources", async (c) => c.json(await fetchKeplerResourceCatalog()));
  app.get("/kepler/solar", async (c) => c.json({ irradiance: await fetchKeplerSolarIrradiance() }));
  app.get("/kepler/habitats/:habitatId/registration", async (c) => c.json(await fetchKeplerHabitatRegistration(c.req.param("habitatId"))));

  app.post("/commands/register", async (c) => {
    const { name } = (await c.req.json()) as { name: string };
    const data = await stateService.getState();
    if (data.registration) throw new Error(`This directory is already registered as '${data.registration.displayName}'.`);
    const now = new Date().toISOString();
    data.registration = { displayName: name, registeredAt: now, lastSyncedAt: now };
    return c.json(await stateService.saveState(data));
  });
  app.post("/commands/link", async (c) => {
    const { id } = (await c.req.json()) as { id: string };
    const data = await stateService.getState();
    if (data.registration) throw new Error(`This directory is already registered as '${data.registration.displayName}'.`);
    const habitat = await fetchKeplerHabitatRegistration(id);
    const now = new Date().toISOString();
    data.registration = { displayName: habitat.displayName, registeredAt: now, lastSyncedAt: now, habitatId: habitat.id, habitatSlug: habitat.habitatSlug, catalogVersion: habitat.catalogVersion, remoteStatus: habitat.status, lastSeenAt: habitat.lastSeenAt ?? null };
    return c.json(await stateService.saveState(data));
  });
  app.delete("/commands/unregister", async (c) => {
    const data = await stateService.getState();
    const displayName = data.registration?.displayName;
    delete data.registration;
    await stateService.saveState(data);
    return c.json({ displayName });
  });
  app.get("/commands/status", async (c) => c.json(await stateService.getState()));
  app.get("/commands/solar/status", async (c) => {
    const data = await stateService.getState();
    const irradiance = await fetchKeplerSolarIrradiance();
    const chargers = data.modules.filter((module) => moduleCurrentState(module) === "online" && isCharger(module));
    return c.json({ irradiance, chargers: chargers.length, totalChargePerTick: chargers.length });
  });

  app.get("/commands/blueprint/list", async (c) => {
    const blueprints = await fetchKeplerBlueprintCatalog();
    const data = await stateService.getState();
    data.blueprints = blueprints;
    await stateService.saveState(data);
    return c.json(blueprints);
  });
  app.get("/commands/blueprint/:blueprintId", async (c) => {
    const data = await stateService.getState();
    const blueprint = data.blueprints.find((candidate) => candidate.blueprintId === c.req.param("blueprintId"));
    if (!blueprint) throw new Error(`No blueprint with id '${c.req.param("blueprintId")}' exists.`);
    return c.json(blueprint);
  });
  app.get("/commands/resource/list", async (c) => c.json(await fetchKeplerResourceCatalog()));

  app.get("/commands/inventory/list", async (c) => c.json((await stateService.getState()).inventory));
  app.post("/commands/inventory/set", async (c) => c.json(await runInventorySetCommand({ stateService, ...(await c.req.json()) as { resourceId: string; amount: number } })));
  app.get("/commands/construction/list", async (c) => c.json((await stateService.getState()).constructionJobs));
  app.delete("/commands/construction/:jobId", async (c) => {
    const data = await stateService.getState();
    data.constructionJobs = data.constructionJobs.filter((job) => job.id !== c.req.param("jobId"));
    return c.json(await stateService.saveState(data));
  });

  app.post("/commands/construct", async (c) => c.json(await runConstructCommand({ stateService, ...(await c.req.json()) as { blueprintId: string; displayName?: string; moduleName?: string; dryRun?: boolean } })));
  app.post("/commands/module/create", async (c) => c.json(await runConstructCommand({ stateService, ...(await c.req.json()) as { blueprintId: string; displayName?: string; moduleName?: string; dryRun?: boolean } })));
  app.post("/commands/module/set-status", async (c) => c.json(await runModuleSetStatusCommand({ stateService, ...(await c.req.json()) as { moduleId: string; status: string } })));
  app.post("/commands/tick", async (c) => c.json(await runTickCommand({ stateService, count: (await c.req.json()) as { count: number } as any })));

  app.post("/commands/zone/create", async (c) => {
    const { name, purpose, status } = (await c.req.json()) as { name: string; purpose: string; status: string };
    const data = await stateService.getState();
    if (data.zones.some((zone) => zone.name === name)) throw new Error(`A zone named '${name}' already exists.`);
    data.zones.push({ name, purpose, status });
    return c.json(await stateService.saveState(data));
  });
  app.get("/commands/zone/list", async (c) => c.json((await stateService.getState()).zones));
  app.get("/commands/zone/:name", async (c) => c.json(requireItem((await stateService.getState()).zones, (z) => z.name === c.req.param("name"), `No zone named '${c.req.param("name")}' exists.`)));
  app.post("/commands/zone/:name", async (c) => {
    const body = (await c.req.json()) as { purpose?: string; status?: string };
    const data = await stateService.getState();
    const zone = requireItem(data.zones, (z) => z.name === c.req.param("name"), `No zone named '${c.req.param("name")}' exists.`);
    if (body.purpose !== undefined) zone.purpose = body.purpose;
    if (body.status !== undefined) zone.status = body.status;
    return c.json(await stateService.saveState(data));
  });
  app.delete("/commands/zone/:name", async (c) => {
    const data = await stateService.getState();
    data.zones = data.zones.filter((zone) => zone.name !== c.req.param("name"));
    return c.json(await stateService.saveState(data));
  });

  app.post("/commands/airlock/create", async (c) => {
    const body = (await c.req.json()) as { name: string; pressureLevel: number; locked: boolean };
    const data = await stateService.getState();
    if (data.airlocks.some((airlock) => airlock.name === body.name)) throw new Error(`An airlock named '${body.name}' already exists.`);
    data.airlocks.push(body);
    return c.json(await stateService.saveState(data));
  });
  app.get("/commands/airlock/list", async (c) => c.json((await stateService.getState()).airlocks));
  app.get("/commands/airlock/:name", async (c) => c.json(requireItem((await stateService.getState()).airlocks, (a) => a.name === c.req.param("name"), `No airlock named '${c.req.param("name")}' exists.`)));
  app.post("/commands/airlock/:name", async (c) => {
    const body = (await c.req.json()) as { pressureLevel?: number; locked?: boolean };
    const data = await stateService.getState();
    const airlock = requireItem(data.airlocks, (a) => a.name === c.req.param("name"), `No airlock named '${c.req.param("name")}' exists.`);
    if (body.pressureLevel !== undefined) airlock.pressureLevel = body.pressureLevel;
    if (body.locked !== undefined) airlock.locked = body.locked;
    return c.json(await stateService.saveState(data));
  });
  app.delete("/commands/airlock/:name", async (c) => {
    const data = await stateService.getState();
    const name = c.req.param("name");
    data.airlocks = data.airlocks.filter((airlock) => airlock.name !== name);
    for (const door of data.doors) if (door.airlockName === name) delete door.airlockName;
    return c.json(await stateService.saveState(data));
  });
  app.post("/commands/airlock/:name/add-door", async (c) => {
    const { doorName } = (await c.req.json()) as { doorName: string };
    const data = await stateService.getState();
    const airlock = requireItem(data.airlocks, (a) => a.name === c.req.param("name"), `No airlock named '${c.req.param("name")}' exists.`);
    const door = requireItem(data.doors, (d) => d.name === doorName, `No door named '${doorName}' exists.`);
    door.airlockName = airlock.name;
    return c.json(await stateService.saveState(data));
  });

  app.post("/commands/door/create", async (c) => {
    const { name } = (await c.req.json()) as { name: string };
    const data = await stateService.getState();
    if (data.doors.some((door) => door.name === name)) throw new Error(`A door named '${name}' already exists.`);
    data.doors.push({ name });
    return c.json(await stateService.saveState(data));
  });
  app.get("/commands/door/list", async (c) => c.json((await stateService.getState()).doors));
  app.get("/commands/door/:name", async (c) => c.json(requireItem((await stateService.getState()).doors, (d) => d.name === c.req.param("name"), `No door named '${c.req.param("name")}' exists.`)));
  app.post("/commands/door/:name", async (c) => {
    const { name } = (await c.req.json()) as { name: string };
    const data = await stateService.getState();
    const door = requireItem(data.doors, (d) => d.name === c.req.param("name"), `No door named '${c.req.param("name")}' exists.`);
    door.name = name;
    return c.json(await stateService.saveState(data));
  });
  app.delete("/commands/door/:name", async (c) => {
    const data = await stateService.getState();
    const next = data.doors.filter((door) => door.name !== c.req.param("name"));
    if (next.length === data.doors.length) throw new Error(`No door named '${c.req.param("name")}' exists.`);
    data.doors = next;
    return c.json(await stateService.saveState(data));
  });

  app.get("/commands/module/list", async (c) => c.json((await stateService.getState()).modules));
  app.get("/commands/module/status", async (c) => c.json((await stateService.getState()).modules));
  app.post("/commands/module/normalize-names", async (c) => {
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
    const body = (await c.req.json()) as { name?: string; status?: string };
    const data = await stateService.getState();
    const module = requireItem(data.modules, (m) => m.name === c.req.param("name") || m.id === c.req.param("name") || m.displayName === c.req.param("name"), `No module named '${c.req.param("name")}' exists.`);
    if (body.name !== undefined) module.displayName = body.name;
    if (body.status !== undefined) module.runtimeAttributes = { ...module.runtimeAttributes, state: body.status, status: body.status };
    return c.json(await stateService.saveState(data));
  });
  app.delete("/commands/module/:name", async (c) => {
    const data = await stateService.getState();
    data.modules = data.modules.filter((module) => module.displayName !== c.req.param("name"));
    return c.json(await stateService.saveState(data));
  });

  app.get("/commands/debug/battery-drain", async (c) => {
    const data = await stateService.getState();
    return c.json(data.modules.filter((module) => isBattery(module as never)).map((module) => ({ name: module.displayName, chargeLossPerTickMult: typeof module.runtimeAttributes.chargeLossPerTickMult === "number" ? module.runtimeAttributes.chargeLossPerTickMult : 1, drain: batteryConstructionDrainPerTick(module as never) })));
  });
  app.post("/commands/debug/recharge-batteries", async (c) => {
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

  return app;
}
