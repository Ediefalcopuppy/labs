export type ClockMode = "manual" | "kepler";

export type ClockConnectionState =
  | "connected"
  | "connecting"
  | "disconnected"
  | "error";

export type ClockState = {
  mode: ClockMode;
  listeningEnabled: boolean;
  connectionState: ClockConnectionState;
  latestPlanetTick: number | null;
  latestAdvancedBy: number | null;
  lastConnectedAt: string | null;
  lastMessageAt: string | null;
  latestError: string | null;
};

export type ClockStatus = ClockState & {
  manualTicksAllowed: boolean;
};

export type RegistrationStream = {
  protocolVersion: string;
  subscriptions: string[];
  currentTick: number;
  tickIntervalMs: number;
  ticksPerPulse: number;
  status: "paused" | "running";
};

export type PlanetTickNotice = {
  type: "planet_tick";
  previousTick: number;
  tick: number;
  advancedBy: number;
  secondsPerTick: number;
  issuedAt: string;
};

export type ClockEvent = {
  type: "planet_tick";
  tick: number;
  advancedBy: number;
  issuedAt: string;
  applied: boolean;
};

export const DEFAULT_CLOCK_STATE: ClockState = {
  mode: "manual",
  listeningEnabled: false,
  connectionState: "disconnected",
  latestPlanetTick: null,
  latestAdvancedBy: null,
  lastConnectedAt: null,
  lastMessageAt: null,
  latestError: null,
};
