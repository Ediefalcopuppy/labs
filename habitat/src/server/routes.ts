import { Hono } from "hono";
import { registerHealthRoute } from "./health";
import { createStateService, type StateService } from "../state/service";
import {
  fetchKeplerBlueprintCatalog,
  fetchKeplerHabitatRegistration,
  fetchKeplerResourceCatalog,
  fetchKeplerSolarIrradiance,
} from "../kepler/service";

const defaultStateService = createStateService({ storagePath: ".habitat/habitat.sqlite" });

export function createApp(stateService: StateService = defaultStateService): Hono {
  const app = new Hono();
  registerHealthRoute(app);
  app.get("/state", async (c) => c.json(await stateService.getState()));
  app.post("/state", async (c) => c.json(await stateService.saveState(await c.req.json())));
  app.delete("/state", async (c) => c.json(await stateService.resetState()));
  app.get("/kepler/blueprints", async (c) => c.json(await fetchKeplerBlueprintCatalog()));
  app.get("/kepler/resources", async (c) => c.json(await fetchKeplerResourceCatalog()));
  app.get("/kepler/solar", async (c) => c.json({ irradiance: await fetchKeplerSolarIrradiance() }));
  app.get("/kepler/habitats/:habitatId/registration", async (c) => {
    const habitatId = c.req.param("habitatId");
    return c.json(await fetchKeplerHabitatRegistration(habitatId));
  });
  return app;
}
