import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { createAuthService, type User, type UserRole } from "../auth";
import { batteryConstructionDrainPerTick, BATTERY_MAX_CHARGE } from "../construction";
import { runConstructCommand, runDebugConstructCommand, runInventorySetCommand, runModuleSetStatusCommand, runTickCommand } from "../domain/commands";
import { spendInventoryMaterials } from "../domain/inventory";
import { listHumans } from "../domain/humans";
import { normalizeModuleNames } from "../domain/modules";
import { readJsonFile, writeSqliteState } from "../storage";
import { collectKeplerWorldResource, fetchKeplerBlueprintCatalog, fetchKeplerHabitatRegistration, fetchKeplerHabitatRegistrationDetails, fetchKeplerResourceCatalog, fetchKeplerSolarIrradiance, fetchKeplerWorldScan, fetchKeplerWorldSector, registerKeplerHabitat } from "../kepler/service";
import { registerHealthRoute } from "./health";
import { createStateService, type StateService, normalizeState } from "../state/service";
import type { StarterHuman, StarterModuleRegistration } from "../state/types";

const defaultStateService = createStateService({ storagePath: ".habitat/habitat.sqlite" });
const defaultAuthService = createAuthService(".habitat/habitat.sqlite");

class HttpError extends Error {
  constructor(public status: 401 | 403, message: string) { super(message); }
}

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

function upsertAlert(data: Awaited<ReturnType<StateService["getState"]>>, input: { code: string; title: string; description: string; severity: "warning" | "critical"; subject?: { type: "human"; id: string } }) {
  const now = new Date().toISOString();
  const existing = data.alerts.find((alert) => alert.code === input.code && alert.status === "open" && JSON.stringify(alert.subject) === JSON.stringify(input.subject));
  if (existing) {
    Object.assign(existing, { ...input, lastObservedAt: now, occurrenceCount: typeof existing.occurrenceCount === "number" ? existing.occurrenceCount + 1 : 2 });
    return;
  }
  data.alerts.push({ id: randomUUID(), ...input, source: "eva", status: "open", openedAt: now, lastObservedAt: now, occurrenceCount: 1 });
}

function resolveEvaAlert(data: Awaited<ReturnType<StateService["getState"]>>, code: string) {
  const now = new Date().toISOString();
  for (const alert of data.alerts) if (alert.code === code && alert.status === "open") Object.assign(alert, { status: "resolved", resolvedAt: now, lastObservedAt: now });
}

function materializeRegistrationState(
  data: Awaited<ReturnType<StateService["getState"]>>,
  starterModules: StarterModuleRegistration[] | undefined,
  starterHumans: StarterHuman[] | undefined,
  contacts: unknown,
): void {
  if (starterModules) {
    data.modules = starterModules.map((module) => ({
      ...module,
      name: module.id,
      connectedTo: [...module.connectedTo],
      runtimeAttributes: { ...module.runtimeAttributes },
      capabilities: [...module.capabilities],
    }));
  }

  if (starterHumans) {
    data.humans = starterHumans.map((human) => ({
      id: human.id,
      name: human.displayName,
      moduleId: human.locationModuleId,
    }));
  }

  const contactAlerts = contacts && typeof contacts === "object"
    ? (contacts as Record<string, unknown>).alerts
    : undefined;
  if (Array.isArray(contactAlerts)) {
    data.alerts = contactAlerts
      .filter((alert): alert is Record<string, unknown> => Boolean(alert && typeof alert === "object"))
      .filter((alert) => typeof alert.id === "string" && alert.id.length > 0)
      .map((alert) => ({ ...alert, id: alert.id as string, status: typeof alert.status === "string" ? alert.status : "open" })) as typeof data.alerts;
  }
}

export function createApp(stateService: StateService = defaultStateService): Hono {
  const app = new Hono();
  const authService = defaultAuthService;
  registerHealthRoute(app);
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.status === 401 ? "Authentication required" : "Admin access required", message: error.message }, error.status);
    console.error(`[error] ${c.req.method} ${new URL(c.req.url).pathname}: ${error.message}`);
    return c.json({ error: "Habitat request failed", message: error.message }, 500);
  });
  app.use("*", async (c, next) => {
    const startedAt = Date.now();
    console.log(`[request] ${c.req.method} ${new URL(c.req.url).pathname}`);
    await next();
    console.log(`[response] ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - startedAt}ms`);
  });

  const currentUser = (request: Request): User | undefined => authService.getUserFromRequest(request);
  const requireAdmin = (c: Context): User => {
    const user = currentUser(c.req.raw);
    if (!user) throw new HttpError(401, "Sign in to continue.");
    if (user.role !== "admin") throw new HttpError(403, "This action is only available to admins.");
    return user;
  };

  app.post("/auth/signup", async (c) => {
    const user = await authService.signup(await c.req.json());
    const token = authService.createSession(user);
    return c.json({ user }, 201, { "set-cookie": authService.cookie(token) });
  });
  app.post("/auth/login", async (c) => {
    const user = await authService.login(await c.req.json());
    const token = authService.createSession(user);
    return c.json({ user }, 200, { "set-cookie": authService.cookie(token) });
  });
  app.post("/auth/logout", async (c) => {
    authService.clearSession(c.req.raw);
    return c.json({ ok: true }, 200, { "set-cookie": authService.expiredCookie() });
  });
  app.get("/auth/me", (c) => c.json({ user: currentUser(c.req.raw) ?? null }));
  app.get("/admin/users", async (c) => { requireAdmin(c); return c.json(await authService.listUsers()); });
  app.post("/admin/users/:username/role", async (c) => { requireAdmin(c); const body = await c.req.json() as { role?: UserRole }; return c.json(await authService.setRole(c.req.param("username"), body.role ?? "user")); });

  app.get("/state", async (c) => c.json(await stateService.getState()));
  app.get("/humans", async (c) => c.json(await listHumans(stateService)));
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
  app.get("/commands/registration/details", async (c) => {
    console.log("[action] inspect registration details");
    const data = await stateService.getState();
    const registration = data.registration;

    if (!registration?.habitatId) {
      throw new Error("Habitat registration must include a habitatId before listing registration details.");
    }

    return c.json({
      registration,
      kepler: await fetchKeplerHabitatRegistrationDetails(registration.habitatId),
    });
  });

  app.post("/commands/register", async (c) => {
    console.log("[action] register habitat");
    const { name } = (await c.req.json()) as { name: string };
    const data = await stateService.getState();
    if (data.registration) throw new Error(`This directory is already registered as '${data.registration.displayName}'.`);
    const keplerRegistration = await registerKeplerHabitat({ displayName: name, habitatUuid: randomUUID() });
    const now = new Date().toISOString();
    data.registration = {
      displayName: name,
      registeredAt: now,
      lastSyncedAt: now,
      habitatId: keplerRegistration.habitatId,
      starterModules: keplerRegistration.starterModules,
      starterHumans: keplerRegistration.starterHumans,
      contracts: keplerRegistration.contracts,
    };
    materializeRegistrationState(
      data,
      keplerRegistration.starterModules,
      keplerRegistration.starterHumans,
      undefined,
    );
    return c.json(await stateService.saveState(data));
  });
  app.post("/commands/link", async (c) => {
    console.log("[action] link habitat");
    const { id } = (await c.req.json()) as { id: string };
    const data = await stateService.getState();
    if (data.registration) throw new Error(`This directory is already registered as '${data.registration.displayName}'.`);
    const habitat = await fetchKeplerHabitatRegistration(id);
    const now = new Date().toISOString();
    data.registration = { displayName: habitat.displayName, registeredAt: now, lastSyncedAt: now, habitatId: habitat.id, habitatSlug: habitat.habitatSlug, catalogVersion: habitat.catalogVersion, remoteStatus: habitat.status, lastSeenAt: habitat.lastSeenAt ?? null, starterHumans: habitat.starterHumans, starterModules: habitat.starterModules, contracts: habitat.contracts, contacts: habitat.contacts };
    materializeRegistrationState(data, habitat.starterModules, habitat.starterHumans, habitat.contacts);
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
    const data = await stateService.getState();
    const registration = data.registration;
    if (!registration?.habitatId) {
      throw new Error("Habitat registration must include a habitatId before resource scanning.");
    }

    const hasX = body.x !== undefined;
    const hasY = body.y !== undefined;
    if (hasX !== hasY) {
      throw new Error("x and y must be provided together, or both omitted to use the deployed EVA position.");
    }
    const x = hasX && hasY
      ? parseIntegerInRange(body.x, "x", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      : (() => {
          if (!data.eva.deployed) throw new Error("EVA must be deployed before scanning without explicit coordinates.");
          return data.eva.x;
        })();
    const y = hasX && hasY
      ? parseIntegerInRange(body.y, "y", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      : data.eva.y;

    const scan = await fetchKeplerWorldScan({
      habitatId: registration.habitatId,
      x,
      y,
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

  app.post("/commands/debug/human", async (c) => {
    const body = (await c.req.json()) as {
      id?: unknown;
      name?: unknown;
      moduleId?: unknown;
      x?: unknown;
      y?: unknown;
      status?: unknown;
    };
    if (typeof body.id !== "string" || body.id.length === 0) throw new Error("id must be a non-empty string.");
    if (body.name !== undefined && typeof body.name !== "string") throw new Error("name must be a string.");
    if (body.moduleId !== undefined && typeof body.moduleId !== "string") throw new Error("moduleId must be a string.");
    if ((body.x === undefined) !== (body.y === undefined)) throw new Error("x and y must be provided together.");
    const data = await stateService.getState();
    if (data.humans.some((human) => human.id === body.id)) throw new Error(`A human with id '${body.id}' already exists.`);
    const human = {
      id: body.id,
      name: typeof body.name === "string" && body.name.length > 0 ? body.name : body.id,
      ...(typeof body.moduleId === "string" && body.moduleId.length > 0 ? { moduleId: body.moduleId } : {}),
      ...(body.x !== undefined && body.y !== undefined
        ? {
            x: parseIntegerInRange(body.x, "x", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
            y: parseIntegerInRange(body.y, "y", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
          }
        : {}),
      status: typeof body.status === "string" && body.status.length > 0 ? body.status : "available",
    };
    console.log(`[action] debug add human ${body.id}`);
    data.humans.push(human);
    return c.json(await stateService.saveState(data));
  });
  app.post("/commands/human/move", async (c) => {
    const body = (await c.req.json()) as { humanId?: unknown; moduleId?: unknown };
    if (typeof body.humanId !== "string" || body.humanId.length === 0) throw new Error("humanId must be a non-empty string.");
    if (typeof body.moduleId !== "string" || body.moduleId.length === 0) throw new Error("moduleId must be a non-empty string.");
    console.log(`[action] move human ${body.humanId} to ${body.moduleId}`);
    const data = await stateService.getState();
    const human = requireItem(data.humans, (candidate) => candidate.id === body.humanId, `No human with id '${body.humanId}' exists.`);
    const destination = requireItem(
      data.modules,
      (candidate) => candidate.id === body.moduleId || candidate.name === body.moduleId || candidate.displayName === body.moduleId,
      `No module named '${body.moduleId}' exists.`,
    );
    const crewCapacity = destination.runtimeAttributes.crewCapacity;
    const capacity = typeof crewCapacity === "number" && Number.isFinite(crewCapacity) ? crewCapacity : 0;
    const occupants = data.humans.filter((candidate) => candidate.moduleId === destination.id && candidate.id !== human.id).length;
    if (occupants >= capacity) throw new Error(`Module '${body.moduleId}' is full.`);
    human.moduleId = destination.id;
    return c.json(await stateService.saveState(data));
  });

  app.get("/commands/eva/status", async (c) => {
    console.log("[action] inspect EVA status");
    return c.json((await stateService.getState()).eva);
  });
  app.post("/commands/eva/deploy", async (c) => {
    const body = (await c.req.json()) as { humanId?: unknown };
    if (typeof body.humanId !== "string" || body.humanId.length === 0) throw new Error("humanId must be a non-empty string.");
    console.log(`[action] deploy EVA for human ${body.humanId}`);
    const data = await stateService.getState();
    if (data.eva.deployed) throw new Error(`EVA is already deployed for human '${data.eva.humanId ?? "unknown"}'.`);
    const human = requireItem(data.humans, (candidate) => candidate.id === body.humanId, `No human with id '${body.humanId}' exists.`);
    const suitport = data.modules.find((module) => module.blueprintId === "basic-suitport" || module.capabilities.includes("suitport-access"));
    if (!suitport || human.moduleId !== suitport.id) throw new Error("The selected human must be inside the registered suitport before EVA deployment.");
    data.eva = { deployed: true, humanId: human.id, x: 0, y: 0, carriedResources: {}, maxCarryingCapacityKg: data.eva.maxCarryingCapacityKg };
    human.status = "deployed";
    upsertAlert(data, { code: "eva-human-deployed", title: "Human deployed outside habitat", description: `${human.name ?? human.id} is on EVA outside the habitat.`, severity: "warning", subject: { type: "human", id: human.id } });
    return c.json(await stateService.saveState(data));
  });
  app.post("/commands/eva/move", async (c) => {
    const body = (await c.req.json()) as { x?: unknown; y?: unknown };
    const x = parseIntegerInRange(body.x, "x", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const y = parseIntegerInRange(body.y, "y", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    console.log(`[action] move EVA to (${x}, ${y})`);
    const data = await stateService.getState();
    if (!data.eva.deployed) throw new Error("EVA must be deployed before it can move.");
    if (Math.abs(x - data.eva.x) + Math.abs(y - data.eva.y) !== 1) throw new Error("EVA movement must be to an adjacent grid tile.");
    if (!data.registration?.habitatId) throw new Error("Habitat registration must include a habitatId before EVA movement.");
    const bounds = await fetchKeplerWorldSector(data.registration.habitatId);
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) throw new Error("EVA destination is outside the current Kepler sector.");
    data.eva.x = x;
    data.eva.y = y;
    return c.json(await stateService.saveState(data));
  });
  app.post("/commands/eva/dock", async (c) => {
    console.log("[action] dock EVA");
    const data = await stateService.getState();
    if (!data.eva.deployed) throw new Error("EVA is already docked.");
    if (data.eva.x !== 0 || data.eva.y !== 0) throw new Error("EVA can dock only at (0, 0).");
    for (const [resourceId, quantity] of Object.entries(data.eva.carriedResources)) {
      data.inventory[resourceId] = (data.inventory[resourceId] ?? 0) + quantity;
    }
    const human = data.eva.humanId ? data.humans.find((candidate) => candidate.id === data.eva.humanId) : undefined;
    if (human) human.status = "docked";
    resolveEvaAlert(data, "eva-human-deployed");
    resolveEvaAlert(data, "eva-carrying-capacity-reached");
    data.eva = { deployed: false, x: 0, y: 0, carriedResources: {}, maxCarryingCapacityKg: data.eva.maxCarryingCapacityKg };
    return c.json(await stateService.saveState(data));
  });
  app.post("/commands/collect", async (c) => {
    const body = (await c.req.json()) as { quantityKg?: unknown };
    const quantityKg = parseFiniteNumber(body.quantityKg, "quantityKg");
    if (quantityKg <= 0) throw new Error("quantityKg must be greater than zero.");
    console.log(`[action] collect ${quantityKg}kg`);
    const data = await stateService.getState();
    if (!data.eva.deployed) throw new Error("EVA must be deployed before collecting material.");
    if (!data.registration?.habitatId) throw new Error("Habitat registration must include a habitatId before collecting material.");
    const carriedKg = Object.values(data.eva.carriedResources).reduce((total, amount) => total + amount, 0);
    if (carriedKg + quantityKg > data.eva.maxCarryingCapacityKg) throw new Error("Requested collection exceeds EVA carrying capacity.");
    let collection: { resourceType: string; collectedKg: number };
    try {
      collection = await collectKeplerWorldResource({ habitatId: data.registration.habitatId, x: data.eva.x, y: data.eva.y, quantityKg });
    } catch (error) {
      upsertAlert(data, { code: "eva-collection-failed", title: "EVA collection failed", description: error instanceof Error ? error.message : "Kepler rejected the collection attempt.", severity: "warning", subject: data.eva.humanId ? { type: "human", id: data.eva.humanId } : undefined });
      await stateService.saveState(data);
      throw error;
    }
    data.eva.carriedResources[collection.resourceType] = (data.eva.carriedResources[collection.resourceType] ?? 0) + collection.collectedKg;
    if (Object.values(data.eva.carriedResources).reduce((total, amount) => total + amount, 0) >= data.eva.maxCarryingCapacityKg) upsertAlert(data, { code: "eva-carrying-capacity-reached", title: "EVA carrying capacity reached", description: "The EVA satchel is full and must be returned to the habitat.", severity: "warning", subject: data.eva.humanId ? { type: "human", id: data.eva.humanId } : undefined });
    return c.json(await stateService.saveState(data));
  });

  app.get("/commands/alert/list", async (c) => {
    console.log("[action] list alerts");
    return c.json((await stateService.getState()).alerts);
  });
  app.post("/commands/alert/:alertId/acknowledge", async (c) => {
    const alertId = c.req.param("alertId");
    console.log(`[action] acknowledge alert ${alertId}`);
    const data = await stateService.getState();
    const alert = requireItem(data.alerts, (candidate) => candidate.id === alertId, `No alert with id '${alertId}' exists.`);
    alert.status = "acknowledged";
    return c.json(await stateService.saveState(data));
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
    requireAdmin(c);
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
    const deleted = data.modules.find((module) => module.id === name || module.name === name || module.displayName === name);
    if (deleted && data.humans.some((human) => human.moduleId === deleted.id)) throw new Error(`Module '${name}' is occupied and cannot be deleted.`);
    data.modules = next;
    return c.json(await stateService.saveState(data));
  });

  app.get("/commands/debug/battery-drain", async (c) => {
    requireAdmin(c);
    console.log("[action] inspect battery drain");
    const data = await stateService.getState();
    return c.json(data.modules.filter((module) => isBattery(module as never)).map((module) => ({ name: module.displayName, chargeLossPerTickMult: typeof module.runtimeAttributes.chargeLossPerTickMult === "number" ? module.runtimeAttributes.chargeLossPerTickMult : 1, drain: batteryConstructionDrainPerTick(module as never) })));
  });
  app.post("/commands/debug/recharge-batteries", async (c) => {
    requireAdmin(c);
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
    requireAdmin(c);
    const state = await stateService.getState();
    await writeSqliteState(join(process.cwd(), ".habitat", "habitat.sqlite"), state);
    return c.json({ restored: false, message: "SQLite state rebuilt from the current habitat state." });
  });
  app.post("/commands/storage/restore", async (c) => {
    requireAdmin(c);
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
