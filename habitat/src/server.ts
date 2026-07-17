import { serve } from "bun";
import "./load-env";
import { ClockEventHub } from "./clock/events";
import {
  createClockService,
  type ClockService,
  type ClockServiceDependencies,
} from "./clock/service";
import { createClockStorage } from "./clock/storage";
import { createApp } from "./server/routes";
import {
  createServerFetchHandler,
  loadOrCreateOperatorToken,
} from "./server/operator";
import { createStateService } from "./state/service";

export { createApp } from "./server/routes";

type SignalName = "SIGINT" | "SIGTERM";

type SignalHandlers = {
  add(signal: SignalName, listener: () => void): void;
  remove(signal: SignalName, listener: () => void): void;
};

type ServerHandle = {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
};

type RuntimeClockDependencies = Omit<
  ClockServiceDependencies,
  "storage" | "getRegistration" | "onPublicEvent"
>;

export type StartServerOptions = {
  storagePath?: string;
  hostname?: string;
  serve?: (options: Parameters<typeof serve>[0]) => ServerHandle;
  signals?: SignalHandlers;
  clockDependencies?: RuntimeClockDependencies;
  createClock?: (dependencies: ClockServiceDependencies) => ClockService;
};

export type ServerRuntime = {
  app: ReturnType<typeof createApp>;
  clock: ClockService;
  events: ClockEventHub;
  server: ServerHandle;
  stop(): Promise<void>;
};

const processSignals: SignalHandlers = {
  add(signal, listener) {
    process.on(signal, listener);
  },
  remove(signal, listener) {
    process.off(signal, listener);
  },
};

export async function startServer(
  port: number,
  options?: StartServerOptions,
): Promise<ServerRuntime> {
  const resolvedOptions = options ?? {};
  const storagePath = resolvedOptions.storagePath ??
    process.env.HABITAT_SQLITE_PATH ??
    ".habitat/habitat.sqlite";
  const stateService = createStateService({ storagePath });
  const clockStorage = createClockStorage(storagePath);
  const events = new ClockEventHub();
  const buildClock = resolvedOptions.createClock ?? createClockService;
  const clock = buildClock({
    ...resolvedOptions.clockDependencies,
    storage: clockStorage,
    getRegistration: async () => (await stateService.getState()).registration,
    onPublicEvent: (event) => events.publish(event),
  });

  await clockStorage.migrate();
  const operatorToken = await loadOrCreateOperatorToken(storagePath);
  try {
    await clock.start();
  } catch (error) {
    events.close();
    try {
      await clock.stop({ preserveListening: true });
    } catch {
      // Preserve the startup failure after making a best effort to close the socket.
    }
    throw error;
  }

  const app = createApp(stateService, clockStorage, clock, events);
  const host = resolvedOptions.hostname ?? process.env.HOST ?? "0.0.0.0";
  const startServing = resolvedOptions.serve ?? serve;
  let server: ServerHandle;
  try {
    const fetchHandler = createServerFetchHandler({
      appFetch: (request) => app.fetch(request),
      stateService,
      storage: clockStorage,
      operatorToken,
    });
    server = startServing({
      hostname: host,
      port,
      fetch: fetchHandler,
    });
  } catch (error) {
    events.close();
    try {
      await clock.stop({ preserveListening: true });
    } catch {
      // Preserve the server-bind failure after making a best effort to close the clock.
    }
    throw error;
  }

  const signals = resolvedOptions.signals ?? processSignals;
  let shutdownPromise: Promise<void> | undefined;
  const handleSignal = (): void => {
    void stop().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[error] Habitat backend shutdown failed: ${message}`);
    });
  };
  const stop = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      signals.remove("SIGINT", handleSignal);
      signals.remove("SIGTERM", handleSignal);
      let serverStopPromise: Promise<void>;
      try {
        serverStopPromise = Promise.resolve(server.stop()).then(() => undefined);
      } catch (error) {
        serverStopPromise = Promise.reject(error);
      }
      events.close();
      let clockStopPromise: Promise<unknown>;
      try {
        clockStopPromise = clock.stop({ preserveListening: true });
      } catch (error) {
        clockStopPromise = Promise.reject(error);
      }
      const [clockResult, serverResult] = await Promise.allSettled([
        clockStopPromise,
        serverStopPromise,
      ]);
      if (clockResult.status === "rejected") throw clockResult.reason;
      if (serverResult.status === "rejected") throw serverResult.reason;
    })();
    return shutdownPromise;
  };

  signals.add("SIGINT", handleSignal);
  signals.add("SIGTERM", handleSignal);
  console.log(`Habitat backend listening on http://${host}:${port}`);

  return { app, clock, events, server, stop };
}

if (import.meta.main) {
  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  await startServer(Number.isFinite(port) ? port : 8787);
}
