import { fetchBackendEventStream } from "../client";
import { moduleCurrentPowerDraw } from "../domain/power";
import type { HabitatRegistration, HabitatState } from "../state/types";
import type { ClockEvent, ClockStatus } from "./types";

export type HabitatStatusRegistration = HabitatRegistration & {
  apiToken?: string;
};

export type HabitatStatusPayload = Omit<HabitatState, "registration"> & {
  registration?: HabitatStatusRegistration;
};

type WriteOutput = (text: string) => void;

type WatchOptions = {
  signal: AbortSignal;
  jsonl: boolean;
  write: WriteOutput;
};

type SignalTarget = {
  on(event: "SIGINT", listener: () => void): void;
  off(event: "SIGINT", listener: () => void): void;
};

type WatchOnSigintOptions = Omit<WatchOptions, "signal"> & {
  signalTarget?: SignalTarget;
  watch?: (options: WatchOptions) => Promise<void>;
};

function display(value: string | number | null): string {
  return value === null ? "none" : String(value);
}

function moduleRuntimeState(
  module: HabitatState["modules"][number],
): string {
  const candidate = module.runtimeAttributes.state ?? module.runtimeAttributes.status;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : "unknown";
}

function formatNestedValue(value: unknown, indent = 2): string[] {
  const rendered = JSON.stringify(value, null, 2);
  if (rendered === undefined) return [];
  const padding = " ".repeat(indent);
  return rendered.split("\n").map((line) => `${padding}${line}`);
}

export function formatClockStatus(status: ClockStatus): string[] {
  const lines = [
    `Clock mode: ${status.mode}`,
    `Kepler listening: ${status.listeningEnabled ? "on" : "off"}`,
    `Manual ticks allowed: ${status.manualTicksAllowed ? "yes" : "no"}`,
    `Connection state: ${status.connectionState}`,
    `Latest absolute Kepler tick: ${display(status.latestPlanetTick)}`,
    `Latest applied advancedBy: ${display(status.latestAdvancedBy)}`,
  ];

  if (status.lastConnectedAt) lines.push(`Last connected at: ${status.lastConnectedAt}`);
  if (status.lastMessageAt) lines.push(`Last message at: ${status.lastMessageAt}`);
  if (status.latestError) lines.push(`Latest connection error: ${status.latestError}`);
  return lines;
}

export function formatHabitatStatus(payload: HabitatStatusPayload): string[] {
  const registration = payload.registration;
  const lines = [`Registered: ${registration ? "yes" : "no"}`];

  if (registration) {
    lines.push(`Habitat name: ${registration.displayName}`);
    if (registration.habitatId) lines.push(`Habitat id: ${registration.habitatId}`);
    if (registration.habitatUuid) lines.push(`Habitat UUID: ${registration.habitatUuid}`);
    if (registration.streamUrl) lines.push(`Stream URL: ${registration.streamUrl}`);
    if (registration.apiToken) lines.push(`Stream token: ${registration.apiToken}`);
    if (registration.stream) {
      lines.push(`Protocol version: ${registration.stream.protocolVersion}`);
      lines.push(`Subscriptions: ${registration.stream.subscriptions.join(", ")}`);
      lines.push(`Registration clock status: ${registration.stream.status}`);
      lines.push(`Registration current tick: ${registration.stream.currentTick}`);
      lines.push(`Registration tick interval: ${registration.stream.tickIntervalMs} ms`);
      lines.push(`Registration ticks per pulse: ${registration.stream.ticksPerPulse}`);
    }
    if (registration.habitatSlug) lines.push(`Habitat slug: ${registration.habitatSlug}`);
    if (registration.remoteStatus) lines.push(`Remote status: ${registration.remoteStatus}`);
    if (registration.catalogVersion) lines.push(`Catalog version: ${registration.catalogVersion}`);
    if (registration.lastSeenAt) lines.push(`Last seen at: ${registration.lastSeenAt}`);
    if (registration.starterHumans !== undefined) {
      lines.push("Starter humans:", ...formatNestedValue(registration.starterHumans));
    }
    if (registration.contacts !== undefined) {
      lines.push("Contacts:", ...formatNestedValue(registration.contacts));
    }
    lines.push(`Registered at: ${registration.registeredAt}`);
    lines.push(`Last synced at: ${registration.lastSyncedAt}`);
  }

  const moduleStates = payload.modules.reduce<Record<string, number>>((counts, module) => {
    const state = moduleRuntimeState(module);
    counts[state] = (counts[state] ?? 0) + 1;
    return counts;
  }, {});
  lines.push(`Zones: ${payload.zones.length}`);
  lines.push(`Airlocks: ${payload.airlocks.length}`);
  lines.push(`Doors: ${payload.doors.length}`);
  lines.push(`Modules: ${payload.modules.length}`);
  lines.push(`Blueprints: ${payload.blueprints.length}`);
  lines.push(`Inventory resources: ${Object.keys(payload.inventory).length}`);
  lines.push(`Construction jobs: ${payload.constructionJobs.length}`);
  lines.push(`Power consumed ticks: ${payload.power.powerConsumedTicks}`);
  if (payload.modules.length > 0) {
    lines.push(
      `Module states: ${Object.entries(moduleStates)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([state, count]) => `${state} ${count}`)
        .join(", ")}`,
    );
    const totalPowerDraw = payload.modules.reduce(
      (total, module) => total + moduleCurrentPowerDraw(module),
      0,
    );
    lines.push(`Total current module power draw: ${totalPowerDraw}`);
    lines.push(`Energy cost for one tick: ${totalPowerDraw}`);
  }
  return lines;
}

function parseClockEvent(value: unknown): ClockEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "planet_tick" ||
    typeof candidate.tick !== "number" ||
    !Number.isInteger(candidate.tick) ||
    candidate.tick < 0 ||
    typeof candidate.advancedBy !== "number" ||
    !Number.isInteger(candidate.advancedBy) ||
    candidate.advancedBy <= 0 ||
    typeof candidate.issuedAt !== "string" ||
    typeof candidate.applied !== "boolean"
  ) {
    return undefined;
  }
  return {
    type: "planet_tick",
    tick: candidate.tick,
    advancedBy: candidate.advancedBy,
    issuedAt: candidate.issuedAt,
    applied: candidate.applied,
  };
}

function formatClockEvent(event: ClockEvent): string {
  return `Planet tick ${event.tick} | advancedBy ${event.advancedBy} | issued ${event.issuedAt} | applied ${event.applied ? "yes" : "no"}\n`;
}

export async function watchClockEvents(options: WatchOptions): Promise<void> {
  let response: Response;
  try {
    response = await fetchBackendEventStream("/clock/events", options.signal);
  } catch (error) {
    if (options.signal.aborted) return;
    throw error;
  }
  if (!response.body) throw new Error("Habitat clock event response did not include a stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const event = parseClockEvent(parsed);
    if (!event) return;
    options.write(options.jsonl ? `${JSON.stringify(event)}\n` : formatClockEvent(event));
  };

  const processLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
  };

  try {
    while (!options.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) processLine(buffer);
    dispatch();
  } catch (error) {
    if (!options.signal.aborted) throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function watchClockEventsOnSigint(
  options: WatchOnSigintOptions,
): Promise<void> {
  const controller = new AbortController();
  const signalTarget = options.signalTarget ?? process;
  const abort = (): void => controller.abort();
  signalTarget.on("SIGINT", abort);
  try {
    await (options.watch ?? watchClockEvents)({
      signal: controller.signal,
      jsonl: options.jsonl,
      write: options.write,
    });
  } finally {
    signalTarget.off("SIGINT", abort);
  }
}
