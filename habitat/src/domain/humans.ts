import type { StateService } from "../state/service";

export async function listHumans(stateService: StateService) {
  return (await stateService.getState()).humans;
}
