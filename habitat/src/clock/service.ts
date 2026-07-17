import { fetchKeplerSolarIrradiance } from "../kepler/service";
import {
  advanceSimulation,
  type SimulationAdvanceResult,
} from "../domain/simulation";
import type { HabitatRegistration } from "../state/types";
import {
  isTrustedKeplerStreamUrl,
  streamUrlContainsSecret,
} from "../kepler/stream-url";
import type { ClockStorage, PlanetTickResult } from "./storage";
import type {
  ClockEvent,
  ClockState,
  ClockStatus,
  PlanetTickNotice,
} from "./types";

type ClockServiceStorage = Pick<
  ClockStorage,
  | "getClockState"
  | "saveClockState"
  | "getRegistrationToken"
  | "applyManualTick"
  | "applyPlanetTick"
>;

export type WebSocketLike = {
  send(value: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; wasClean?: boolean }) => void) | null;
  onerror: (() => void) | null;
};

export type ClockServiceDependencies = {
  storage: ClockServiceStorage;
  getRegistration: () => Promise<HabitatRegistration | undefined>;
  getIrradiance?: () => Promise<number>;
  openWebSocket?: (url: string) => WebSocketLike;
  now?: () => Date;
  scheduleReconnect?: (callback: () => void, delayMs: number) => unknown;
  cancelReconnect?: (handle: unknown) => void;
  reconnectDelayMs?: number;
  onPublicEvent?: (event: ClockEvent) => void;
};

export type SimulationPlanetTickResult = PlanetTickResult<SimulationAdvanceResult>;

type HelloAcknowledgement = {
  type: "hello_ack";
  connectionId: string;
  habitatId: string;
  subscriptions: string[];
  currentTick: number;
  catchUpTicks: number;
  tickIntervalMs: number;
  ticksPerPulse: number;
  clockStatus: "paused" | "running";
  serverTime: string;
};

type ActiveSession = {
  generation: number;
  habitatId: string;
  acknowledged: boolean;
  floor: number | null;
};

type StopOptions = {
  preserveListening?: boolean;
};

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const INVALID_ACK_ERROR = "Kepler clock acknowledgement was invalid.";
const HABITAT_MISMATCH_ERROR =
  "Kepler clock acknowledgement contained an unexpected Habitat ID.";

export class ManualTickUnavailableError extends Error {
  constructor() {
    super(
      "Manual ticks are unavailable while the Kepler listener is enabled. Run `habitat clock listen off` first.",
    );
    this.name = "ManualTickUnavailableError";
  }
}

function toStatus(state: ClockState): ClockStatus {
  return {
    ...state,
    manualTicksAllowed: state.mode === "manual" && !state.listeningEnabled,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function validateHelloAcknowledgement(
  value: unknown,
  habitatId: string,
): { acknowledgement?: HelloAcknowledgement; error?: string } {
  if (!isRecord(value) || value.type !== "hello_ack") {
    return { error: INVALID_ACK_ERROR };
  }
  if (
    typeof value.connectionId !== "string" || value.connectionId.length === 0 ||
    typeof value.habitatId !== "string" || value.habitatId.length === 0 ||
    !Array.isArray(value.subscriptions) ||
    !value.subscriptions.every(
      (subscription) => typeof subscription === "string" && subscription.length > 0,
    ) ||
    !value.subscriptions.includes("ticks") ||
    !isNonnegativeInteger(value.currentTick) ||
    !isNonnegativeInteger(value.catchUpTicks) ||
    !isPositiveInteger(value.tickIntervalMs) ||
    !isPositiveInteger(value.ticksPerPulse) ||
    (value.clockStatus !== "paused" && value.clockStatus !== "running") ||
    !isValidTimestamp(value.serverTime)
  ) {
    return { error: INVALID_ACK_ERROR };
  }
  if (value.habitatId !== habitatId) {
    return { error: HABITAT_MISMATCH_ERROR };
  }

  return {
    acknowledgement: value as HelloAcknowledgement,
  };
}

function isPlanetTickNotice(value: unknown): value is PlanetTickNotice {
  if (!isRecord(value) || value.type !== "planet_tick") return false;
  return (
    isNonnegativeInteger(value.previousTick) &&
    isNonnegativeInteger(value.tick) &&
    isPositiveInteger(value.advancedBy) &&
    value.tick - value.previousTick === value.advancedBy &&
    typeof value.secondsPerTick === "number" &&
    Number.isFinite(value.secondsPerTick) &&
    value.secondsPerTick >= 0.25 &&
    value.secondsPerTick <= 60 &&
    isValidTimestamp(value.issuedAt)
  );
}

function parseRawMessage(rawMessage: unknown): Record<string, unknown> | undefined {
  if (typeof rawMessage !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(rawMessage);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function registrationError(registration: HabitatRegistration | undefined): string | undefined {
  if (!registration) return "No saved Kepler registration is available for clock listening.";
  const stream: unknown = registration.stream;
  if (
    typeof registration.habitatId !== "string" || registration.habitatId.length === 0 ||
    typeof registration.streamUrl !== "string" || registration.streamUrl.length === 0 ||
    !isRecord(stream) ||
    !Array.isArray(stream.subscriptions) ||
    !stream.subscriptions.every((subscription) => typeof subscription === "string")
  ) {
    return "The saved Kepler registration is missing live clock stream metadata.";
  }
  if (!stream.subscriptions.includes("ticks")) {
    return "The saved Kepler registration does not advertise the ticks subscription.";
  }
  return undefined;
}

function streamUrlContainsCredential(streamUrl: string, apiToken: string): boolean {
  return streamUrlContainsSecret(streamUrl, apiToken);
}

function savedStreamUrlError(streamUrl: string): string | undefined {
  if (!isTrustedKeplerStreamUrl(streamUrl)) {
    return "The saved Kepler clock stream URL is not a trusted Kepler WebSocket origin.";
  }
  try {
    decodeURIComponent(streamUrl);
  } catch {
    return "The saved Kepler clock stream URL contains malformed URL encoding.";
  }
  return undefined;
}

export function createClockService(dependencies: ClockServiceDependencies) {
  const getIrradiance = dependencies.getIrradiance ?? fetchKeplerSolarIrradiance;
  const openWebSocket = dependencies.openWebSocket ?? ((url: string) =>
    new WebSocket(url) as unknown as WebSocketLike);
  const now = dependencies.now ?? (() => new Date());
  const schedule = dependencies.scheduleReconnect ?? ((callback, delayMs) =>
    setTimeout(callback, delayMs));
  const cancel = dependencies.cancelReconnect ?? ((handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>));
  const reconnectDelayMs = dependencies.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const publish = dependencies.onPublicEvent ?? (() => undefined);

  let operationTail: Promise<void> = Promise.resolve();
  let acceptingValidatedNotices = false;
  let acceptanceGeneration = 0;
  let socketGeneration = 0;
  let activeSocket: WebSocketLike | null = null;
  let activeSession: ActiveSession | null = null;
  let reconnectHandle: unknown | null = null;
  let noticeRetryHandle: unknown | null = null;
  const pendingNotices: PlanetTickNotice[] = [];
  let runtimeStarted = false;
  let stopped = false;
  let stopPromise: Promise<ClockStatus> | null = null;

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function isCurrentSession(generation: number): boolean {
    return (
      activeSocket !== null &&
      activeSession !== null &&
      activeSession.generation === generation &&
      socketGeneration === generation
    );
  }

  function cancelPendingReconnect(): void {
    if (reconnectHandle === null) return;
    cancel(reconnectHandle);
    reconnectHandle = null;
  }

  function cancelPendingNoticeRetry(): void {
    if (noticeRetryHandle === null) return;
    cancel(noticeRetryHandle);
    noticeRetryHandle = null;
  }

  function discardPendingNotices(): void {
    cancelPendingNoticeRetry();
    pendingNotices.length = 0;
  }

  function scheduleNoticeRetry(): void {
    if (
      noticeRetryHandle !== null ||
      pendingNotices.length === 0 ||
      stopped ||
      !acceptingValidatedNotices
    ) {
      return;
    }
    noticeRetryHandle = schedule(() => {
      noticeRetryHandle = null;
      if (stopped || !acceptingValidatedNotices || pendingNotices.length === 0) {
        return;
      }
      void enqueue(drainPendingNotices).catch(() => {
        scheduleNoticeRetry();
      });
    }, reconnectDelayMs);
  }

  function detachSocketCallbacks(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  function retireActiveSocket(closeSocket: boolean): void {
    const socket = activeSocket;
    activeSocket = null;
    activeSession = null;
    socketGeneration += 1;
    if (!socket) return;

    detachSocketCallbacks(socket);
    if (closeSocket) {
      try {
        socket.close();
      } catch {
        // The connection is already retired; close failures are non-fatal.
      }
    }
  }

  async function persistConnectionState(
    intentGeneration: number,
    connectionState: ClockState["connectionState"],
    latestError: string | null,
  ): Promise<ClockState> {
    const current = await dependencies.storage.getClockState();
    if (
      intentGeneration !== acceptanceGeneration ||
      stopped ||
      current.mode !== "kepler" ||
      !current.listeningEnabled
    ) {
      return current;
    }
    return dependencies.storage.saveClockState({
      ...current,
      connectionState,
      latestError,
    });
  }

  function retainsKeplerIntent(
    state: ClockState,
    intentGeneration: number,
  ): boolean {
    return (
      !stopped &&
      acceptingValidatedNotices &&
      intentGeneration === acceptanceGeneration &&
      state.mode === "kepler" &&
      state.listeningEnabled
    );
  }

  function scheduleReconnect(intentGeneration: number): void {
    if (
      reconnectHandle !== null ||
      stopped ||
      !acceptingValidatedNotices ||
      intentGeneration !== acceptanceGeneration
    ) {
      return;
    }

    reconnectHandle = schedule(() => {
      reconnectHandle = null;
      if (
        stopped ||
        !acceptingValidatedNotices ||
        intentGeneration !== acceptanceGeneration
      ) {
        return;
      }
      void enqueue(async () => {
        const current = await dependencies.storage.getClockState();
        if (
          stopped ||
          !acceptingValidatedNotices ||
          intentGeneration !== acceptanceGeneration ||
          current.mode !== "kepler" ||
          !current.listeningEnabled
        ) {
          return;
        }
        await dependencies.storage.saveClockState({
          ...current,
          connectionState: "connecting",
        });
        await attemptConnection(intentGeneration);
      }).catch(() => {
        scheduleReconnect(intentGeneration);
      });
    }, reconnectDelayMs);
  }

  async function failConnectionAttempt(
    intentGeneration: number,
    message: string,
  ): Promise<ClockState> {
    const saved = await persistConnectionState(intentGeneration, "error", message);
    if (retainsKeplerIntent(saved, intentGeneration)) {
      scheduleReconnect(intentGeneration);
    }
    return saved;
  }

  async function attemptConnection(intentGeneration: number): Promise<ClockState> {
    if (
      stopped ||
      !acceptingValidatedNotices ||
      intentGeneration !== acceptanceGeneration
    ) {
      return dependencies.storage.getClockState();
    }

    let registration: HabitatRegistration | undefined;
    try {
      registration = await dependencies.getRegistration();
    } catch {
      return failConnectionAttempt(
        intentGeneration,
        "Unable to read the saved Kepler registration for clock listening.",
      );
    }

    const error = registrationError(registration);
    if (error || !registration?.habitatId || !registration.streamUrl) {
      return failConnectionAttempt(
        intentGeneration,
        error ?? "The saved Kepler registration is incomplete.",
      );
    }

    const streamUrlError = savedStreamUrlError(registration.streamUrl);
    if (streamUrlError) {
      return failConnectionAttempt(intentGeneration, streamUrlError);
    }

    let apiToken: string | undefined;
    try {
      apiToken = await dependencies.storage.getRegistrationToken(registration.habitatId);
    } catch {
      return failConnectionAttempt(
        intentGeneration,
        "Unable to load the isolated Kepler clock credential.",
      );
    }
    if (typeof apiToken !== "string" || apiToken.length === 0) {
      return failConnectionAttempt(
        intentGeneration,
        "The isolated Kepler clock credential is missing.",
      );
    }
    if (streamUrlContainsCredential(registration.streamUrl, apiToken)) {
      return failConnectionAttempt(
        intentGeneration,
        "The saved Kepler clock stream URL contains credential material.",
      );
    }
    if (
      stopped ||
      !acceptingValidatedNotices ||
      intentGeneration !== acceptanceGeneration
    ) {
      return dependencies.storage.getClockState();
    }

    let socket: WebSocketLike;
    try {
      socket = openWebSocket(registration.streamUrl);
    } catch {
      return failConnectionAttempt(
        intentGeneration,
        "Unable to open the saved Kepler clock stream.",
      );
    }

    if (
      stopped ||
      !acceptingValidatedNotices ||
      intentGeneration !== acceptanceGeneration
    ) {
      try {
        socket.close();
      } catch {
        // The abandoned socket has no effect on clock intent.
      }
      return dependencies.storage.getClockState();
    }

    if (activeSocket) retireActiveSocket(true);
    const generation = ++socketGeneration;
    activeSocket = socket;
    activeSession = {
      generation,
      habitatId: registration.habitatId,
      acknowledged: false,
      floor: null,
    };

    socket.onopen = () => {
      if (!isCurrentSession(generation)) return;
      try {
        socket.send(JSON.stringify({
          type: "hello",
          apiToken,
          subscribe: ["ticks"],
        }));
      } catch {
        handleUnexpectedError(generation);
      }
    };
    socket.onmessage = (event) => {
      void handleRawMessageForGeneration(event.data, generation).catch(() => {
        handleUnexpectedError(generation);
      });
    };
    socket.onclose = (event) => {
      handleUnexpectedClose(generation, event.code);
    };
    socket.onerror = () => {
      handleUnexpectedError(generation);
    };

    return dependencies.storage.getClockState();
  }

  function handleUnexpectedClose(generation: number, code?: number): void {
    if (!isCurrentSession(generation)) return;
    const intentGeneration = acceptanceGeneration;
    if (activeSocket) detachSocketCallbacks(activeSocket);
    const message = typeof code === "number"
      ? `Kepler clock stream closed unexpectedly (code ${code}).`
      : "Kepler clock stream closed unexpectedly.";
    void enqueue(async () => {
      if (!isCurrentSession(generation)) return;
      retireActiveSocket(false);
      const saved = await persistConnectionState(intentGeneration, "disconnected", message);
      if (retainsKeplerIntent(saved, intentGeneration)) {
        scheduleReconnect(intentGeneration);
      }
    }).catch(() => {
      scheduleReconnect(intentGeneration);
    });
  }

  function handleUnexpectedError(generation: number): void {
    if (!isCurrentSession(generation)) return;
    const intentGeneration = acceptanceGeneration;
    if (activeSocket) detachSocketCallbacks(activeSocket);
    void enqueue(async () => {
      if (!isCurrentSession(generation)) return;
      retireActiveSocket(true);
      const saved = await persistConnectionState(
        intentGeneration,
        "error",
        "Kepler clock stream encountered a connection error.",
      );
      if (retainsKeplerIntent(saved, intentGeneration)) {
        scheduleReconnect(intentGeneration);
      }
    }).catch(() => {
      scheduleReconnect(intentGeneration);
    });
  }

  async function failProtocol(
    generation: number,
    message: string,
  ): Promise<void> {
    if (!isCurrentSession(generation)) return;
    const intentGeneration = acceptanceGeneration;
    retireActiveSocket(true);
    const saved = await persistConnectionState(intentGeneration, "error", message);
    if (retainsKeplerIntent(saved, intentGeneration)) {
      scheduleReconnect(intentGeneration);
    }
  }

  async function processParsedMessage(
    message: Record<string, unknown>,
    generation: number,
  ): Promise<void> {
    if (
      !acceptingValidatedNotices ||
      stopped ||
      !isCurrentSession(generation) ||
      !activeSession
    ) {
      return;
    }

    if (message.type === "hello_ack") {
      if (activeSession.acknowledged) return;
      const validation = validateHelloAcknowledgement(message, activeSession.habitatId);
      if (!validation.acknowledgement) {
        await failProtocol(
          generation,
          validation.error ?? INVALID_ACK_ERROR,
        );
        return;
      }

      const current = await dependencies.storage.getClockState();
      if (!isCurrentSession(generation) || !activeSession) return;
      activeSession.floor = Math.max(
        validation.acknowledgement.currentTick,
        current.latestPlanetTick ?? 0,
      );
      activeSession.acknowledged = true;
      await dependencies.storage.saveClockState({
        ...current,
        connectionState: "connected",
        lastConnectedAt: now().toISOString(),
        latestError: null,
      });
      return;
    }

    if (
      message.type !== "planet_tick" ||
      !activeSession.acknowledged ||
      activeSession.floor === null ||
      !isPlanetTickNotice(message) ||
      message.tick <= activeSession.floor ||
      message.previousTick < activeSession.floor
    ) {
      return;
    }

    pendingNotices.push(message);
    await drainPendingNotices();
  }

  async function drainPendingNotices(): Promise<void> {
    if (noticeRetryHandle !== null) return;
    while (!stopped && acceptingValidatedNotices && pendingNotices.length > 0) {
      const notice = pendingNotices[0];
      try {
        const irradiance = await getIrradiance();
        const result = await dependencies.storage.applyPlanetTick(notice, (state) =>
          advanceSimulation(state, notice.advancedBy, irradiance));
        const event: ClockEvent = {
          type: "planet_tick",
          tick: notice.tick,
          advancedBy: notice.advancedBy,
          issuedAt: notice.issuedAt,
          applied: result.applied,
        };
        if (pendingNotices[0] === notice) pendingNotices.shift();
        try {
          publish(event);
        } catch {
          // Public observers must not affect the clock or simulation transaction.
        }
      } catch {
        scheduleNoticeRetry();
        return;
      }
    }
  }

  function handleRawMessageForGeneration(
    rawMessage: unknown,
    generation: number,
  ): Promise<void> {
    const parsed = parseRawMessage(rawMessage);
    if (!parsed) return Promise.resolve();
    return enqueue(() => processParsedMessage(parsed, generation));
  }

  function getStatus(): Promise<ClockStatus> {
    return enqueue(async () => toStatus(await dependencies.storage.getClockState()));
  }

  function listenOn(): Promise<ClockStatus> {
    if (stopPromise) return stopPromise;
    runtimeStarted = true;
    stopped = false;
    const intentGeneration = ++acceptanceGeneration;
    acceptingValidatedNotices = true;
    cancelPendingReconnect();
    retireActiveSocket(true);

    return enqueue(async () => {
      const current = await dependencies.storage.getClockState();
      const saved = await dependencies.storage.saveClockState({
        ...current,
        mode: "kepler",
        listeningEnabled: true,
        connectionState: "connecting",
        latestError: null,
      });
      if (intentGeneration !== acceptanceGeneration || stopped) {
        return toStatus(saved);
      }
      return toStatus(await attemptConnection(intentGeneration));
    });
  }

  function listenOff(): Promise<ClockStatus> {
    if (stopPromise) return stopPromise;
    runtimeStarted = true;
    acceptanceGeneration += 1;
    acceptingValidatedNotices = false;
    cancelPendingReconnect();
    discardPendingNotices();
    retireActiveSocket(true);

    return enqueue(async () => {
      const current = await dependencies.storage.getClockState();
      const saved = await dependencies.storage.saveClockState({
        ...current,
        mode: "manual",
        listeningEnabled: false,
        connectionState: "disconnected",
        latestError: null,
      });
      return toStatus(saved);
    });
  }

  function manualTick(count: number): Promise<SimulationAdvanceResult> {
    return enqueue(async () => {
      const clockState = await dependencies.storage.getClockState();
      if (clockState.mode === "kepler" || clockState.listeningEnabled) {
        throw new ManualTickUnavailableError();
      }

      const irradiance = await getIrradiance();
      return dependencies.storage.applyManualTick((state) =>
        advanceSimulation(state, count, irradiance));
    });
  }

  function applyValidatedNotice(
    notice: PlanetTickNotice,
  ): Promise<SimulationPlanetTickResult> {
    if (!acceptingValidatedNotices || !isPlanetTickNotice(notice)) {
      return Promise.resolve({ applied: false });
    }

    return enqueue(async () => {
      const irradiance = await getIrradiance();
      return dependencies.storage.applyPlanetTick(notice, (state) =>
        advanceSimulation(state, notice.advancedBy, irradiance));
    });
  }

  function handleRawMessage(rawMessage: unknown): Promise<void> {
    if (!activeSession) return Promise.resolve();
    return handleRawMessageForGeneration(rawMessage, activeSession.generation);
  }

  function start(): Promise<ClockStatus> {
    if (stopPromise) return stopPromise;
    if (runtimeStarted) return getStatus();
    runtimeStarted = true;
    stopped = false;
    const intentGeneration = ++acceptanceGeneration;

    return enqueue(async () => {
      const current = await dependencies.storage.getClockState();
      if (
        intentGeneration !== acceptanceGeneration ||
        current.mode !== "kepler" ||
        !current.listeningEnabled
      ) {
        acceptingValidatedNotices = false;
        return toStatus(current);
      }

      acceptingValidatedNotices = true;
      const connecting = await dependencies.storage.saveClockState({
        ...current,
        connectionState: "connecting",
        latestError: null,
      });
      if (intentGeneration !== acceptanceGeneration || stopped) {
        return toStatus(connecting);
      }
      return toStatus(await attemptConnection(intentGeneration));
    });
  }

  function stop(options: StopOptions = {}): Promise<ClockStatus> {
    if (stopPromise) return stopPromise;
    const preserveListening = options.preserveListening ?? true;
    runtimeStarted = true;
    stopped = true;
    acceptanceGeneration += 1;
    acceptingValidatedNotices = false;
    cancelPendingReconnect();
    discardPendingNotices();
    retireActiveSocket(true);

    stopPromise = enqueue(async () => {
      const current = await dependencies.storage.getClockState();
      const saved = await dependencies.storage.saveClockState({
        ...current,
        mode: preserveListening ? current.mode : "manual",
        listeningEnabled: preserveListening ? current.listeningEnabled : false,
        connectionState: "disconnected",
        latestError: null,
      });
      return toStatus(saved);
    });
    return stopPromise;
  }

  return {
    applyValidatedNotice,
    getStatus,
    handleRawMessage,
    listenOff,
    listenOn,
    manualTick,
    start,
    stop,
  };
}

export type ClockService = ReturnType<typeof createClockService>;
