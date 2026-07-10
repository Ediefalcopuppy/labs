import { randomUUID } from "node:crypto";
import type { StateService } from "../state/service";
import { fetchKeplerBlueprintCatalog, fetchKeplerSolarIrradiance } from "../kepler/service";
import { spendInventoryMaterials } from "./inventory";
import { planConstructionStart, previewConstructionStart, advanceConstructionTick } from "./construction";
import { setModuleStatus } from "./modules";

export async function runConstructCommand(params: {
  stateService: StateService;
  blueprintId: string;
  displayName?: string;
  moduleName?: string;
  dryRun?: boolean;
  getBlueprints?: typeof fetchKeplerBlueprintCatalog;
}): Promise<unknown> {
  const data = await params.stateService.getState();
  const getBlueprints = params.getBlueprints ?? fetchKeplerBlueprintCatalog;
  const blueprints = await getBlueprints();
  const blueprint = blueprints.find(
    (candidate) => candidate.blueprintId === params.blueprintId || candidate.id === params.blueprintId,
  );

  if (!blueprint) {
    throw new Error(`No blueprint with id '${params.blueprintId}' exists in Kepler.`);
  }

  const report = previewConstructionStart({
    blueprint,
    habitat: data,
    displayName: params.displayName ?? blueprint.displayName,
    moduleName: params.moduleName,
  });

  if (params.dryRun) {
    return report;
  }

  const plan = planConstructionStart({
    blueprint,
    habitat: data,
    displayName: params.displayName ?? blueprint.displayName,
    moduleName: params.moduleName,
  });

  data.blueprints = blueprints;
  data.inventory = spendInventoryMaterials(data.inventory, plan.consumedMaterials);
  data.constructionJobs.push({
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
  });
  await params.stateService.saveState(data);
  return { message: `Started construction for '${plan.displayName}' from blueprint '${blueprint.blueprintId}' using facility '${plan.facility.displayName}'.` };
}

export async function runInventorySetCommand(params: { stateService: StateService; resourceId: string; amount: number }) {
  const data = await params.stateService.getState();
  data.inventory[params.resourceId] = params.amount;
  await params.stateService.saveState(data);
  return data.inventory;
}

export async function runModuleSetStatusCommand(params: {
  stateService: StateService;
  moduleId: string;
  status: string;
}) {
  const data = await params.stateService.getState();
  const module = data.modules.find((candidate) => candidate.id === params.moduleId);
  if (!module) {
    throw new Error(`No module with id '${params.moduleId}' exists.`);
  }
  Object.assign(module, setModuleStatus(module, params.status));
  await params.stateService.saveState(data);
  return module;
}

export async function runTickCommand(params: {
  stateService: StateService;
  count: number;
  getIrradiance?: () => Promise<number>;
}) {
  const data = await params.stateService.getState();
  const completedJobs: string[] = [];
  let advancedConstructionTicks = 0;
  let pausedConstructionTicks = 0;
  let energyCost = 0;
  const getIrradiance = params.getIrradiance ?? fetchKeplerSolarIrradiance;
  for (let step = 0; step < params.count; step += 1) {
    const irradiance = await getIrradiance();
    const result = advanceConstructionTick(data, irradiance);
    energyCost += result.energyCost;
    advancedConstructionTicks += result.advancedConstructionTicks;
    pausedConstructionTicks += result.pausedConstructionTicks;
    completedJobs.push(...result.completedJobs);
  }
  await params.stateService.saveState(data);
  return { completedJobs, advancedConstructionTicks, pausedConstructionTicks, energyCost, data };
}
