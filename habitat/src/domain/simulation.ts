import type { HabitatState } from "../state/types";
import { advanceConstructionTick } from "./construction";

export type SimulationAdvanceResult = {
  completedJobs: string[];
  advancedConstructionTicks: number;
  pausedConstructionTicks: number;
  energyCost: number;
  data: HabitatState;
};

export function advanceSimulation(
  state: HabitatState,
  count: number,
  irradiance: number,
): SimulationAdvanceResult {
  const completedJobs: string[] = [];
  let advancedConstructionTicks = 0;
  let pausedConstructionTicks = 0;
  let energyCost = 0;

  for (let step = 0; step < count; step += 1) {
    const result = advanceConstructionTick(state, irradiance);
    energyCost += result.energyCost;
    advancedConstructionTicks += result.advancedConstructionTicks;
    pausedConstructionTicks += result.pausedConstructionTicks;
    completedJobs.push(...result.completedJobs);
  }

  return {
    completedJobs,
    advancedConstructionTicks,
    pausedConstructionTicks,
    energyCost,
    data: state,
  };
}
