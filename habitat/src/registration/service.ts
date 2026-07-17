import { randomUUID } from "node:crypto";
import type { ClockStorage } from "../clock/storage";
import {
  recoverHabitatUuid,
  registerKeplerHabitat,
} from "../kepler/service";
import { HabitatStateConflictError } from "../storage";
import type { StateService } from "../state/service";
import type {
  HabitatRegistration,
  HabitatState,
  StarterHuman,
  StarterModuleRegistration,
} from "../state/types";

export type RegistrationStorage = Pick<
  ClockStorage,
  "deleteRegistration" | "getRegistrationToken" | "saveRegistration"
>;

const registrationTails = new WeakMap<RegistrationStorage, Promise<void>>();

export function serializeRegistrationLifecycle<T>(
  registrationStorage: RegistrationStorage,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = registrationTails.get(registrationStorage) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  registrationTails.set(registrationStorage, tail);
  void tail.finally(() => {
    if (registrationTails.get(registrationStorage) === tail) {
      registrationTails.delete(registrationStorage);
    }
  });
  return result;
}

export function materializeRegistrationState(
  data: HabitatState,
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
      .map((alert) => ({
        ...alert,
        id: alert.id as string,
        status: typeof alert.status === "string" ? alert.status : "open",
      })) as typeof data.alerts;
  }
}

function assertRegistrationUnchanged(
  latest: HabitatRegistration | undefined,
  expected: HabitatRegistration | undefined,
): void {
  if (!expected) {
    if (latest) {
      throw new Error("Habitat registration changed while Kepler registration was in progress.");
    }
    return;
  }
  if (!latest) {
    throw new Error("Habitat registration was removed while Kepler registration was in progress.");
  }
  if (
    (expected.habitatId && latest.habitatId !== expected.habitatId) ||
    (expected.habitatUuid && latest.habitatUuid && latest.habitatUuid !== expected.habitatUuid)
  ) {
    throw new Error("Habitat registration identity changed while Kepler registration was in progress.");
  }
}

async function persistKeplerRegistrationOnce(
  stateService: Pick<StateService, "getState">,
  registrationStorage: RegistrationStorage,
  requestedDisplayName: string,
): Promise<HabitatState> {
  const data = await stateService.getState();
  const existingRegistration = data.registration;
  const savedStreamToken = existingRegistration?.habitatId
    ? await registrationStorage.getRegistrationToken(existingRegistration.habitatId)
    : undefined;
  if (
    existingRegistration?.streamUrl &&
    existingRegistration.stream &&
    savedStreamToken
  ) {
    throw new Error(
      `This directory is already registered as '${existingRegistration.displayName}'.`,
    );
  }

  const displayName = existingRegistration?.displayName ?? requestedDisplayName;
  const habitatUuid = existingRegistration
    ? existingRegistration.habitatUuid ??
      (existingRegistration.habitatId
        ? recoverHabitatUuid(existingRegistration.habitatId)
        : undefined)
    : randomUUID();
  if (!habitatUuid) {
    throw new Error(
      "The existing Habitat registration does not contain a reusable Habitat UUID.",
    );
  }

  const keplerRegistration = await registerKeplerHabitat({ displayName, habitatUuid });
  if (
    existingRegistration?.habitatId &&
    keplerRegistration.habitatId !== existingRegistration.habitatId
  ) {
    throw new Error(
      "Kepler returned a different Habitat id while upgrading the existing registration.",
    );
  }
  const now = new Date().toISOString();

  for (;;) {
    const latest = await stateService.getState();
    assertRegistrationUnchanged(latest.registration, existingRegistration);
    latest.registration = {
      ...latest.registration,
      displayName,
      registeredAt: existingRegistration?.registeredAt ?? now,
      lastSyncedAt: now,
      habitatId: keplerRegistration.habitatId,
      habitatUuid,
      streamUrl: keplerRegistration.streamUrl,
      stream: keplerRegistration.stream,
      starterModules: keplerRegistration.starterModules,
      starterHumans: keplerRegistration.starterHumans,
      contracts: keplerRegistration.contracts,
    };
    if (!existingRegistration) {
      materializeRegistrationState(
        latest,
        keplerRegistration.starterModules,
        keplerRegistration.starterHumans,
        undefined,
      );
      latest.blueprints = keplerRegistration.blueprints;
    }

    try {
      return await registrationStorage.saveRegistration(
        latest,
        keplerRegistration.apiToken,
      );
    } catch (error) {
      if (error instanceof HabitatStateConflictError) continue;
      throw error;
    }
  }
}

export function persistKeplerRegistration(
  stateService: Pick<StateService, "getState">,
  registrationStorage: RegistrationStorage,
  requestedDisplayName: string,
): Promise<HabitatState> {
  return serializeRegistrationLifecycle(registrationStorage, () =>
    persistKeplerRegistrationOnce(
      stateService,
      registrationStorage,
      requestedDisplayName,
    ));
}
