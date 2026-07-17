import type { HabitatStatusPayload } from "../clock/cli";
import type { ClockStorage } from "../clock/storage";
import type { StateService } from "../state/service";

export const LOCAL_OPERATOR_STATUS_PATH = "/operator/status";

type RequestAddress = {
  address: string;
};

type RequestIpServer = {
  requestIP(request: Request): RequestAddress | null;
};

type OperatorDependencies = {
  appFetch(request: Request): Response | Promise<Response>;
  stateService: Pick<StateService, "getState">;
  storage: Pick<ClockStorage, "getRegistrationToken">;
  operatorToken: string;
};

export function operatorTokenPath(storagePath: string): string {
  return join(dirname(storagePath), "operator.key");
}

export async function loadOrCreateOperatorToken(storagePath: string): Promise<string> {
  const configured = process.env.HABITAT_OPERATOR_TOKEN;
  if (configured) return configured;

  const path = operatorTokenPath(storagePath);
  await mkdir(dirname(path), { recursive: true });
  const readExisting = async (): Promise<string> => {
    const token = (await readFile(path, "utf8")).trim();
    if (token.length < 32) {
      throw new Error("The local Habitat operator credential is invalid.");
    }
    await chmod(path, 0o600);
    return token;
  };

  try {
    return await readExisting();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const generated = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(path, 0o600);
    return generated;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return readExisting();
    }
    throw error;
  }
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const isIpv4Loopback = /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(normalized) &&
    normalized.split(".").every((part) => Number(part) <= 255);
  return (
    isIpv4Loopback ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^::ffff:127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(normalized)
  );
}

function hasOperatorCredential(request: Request, expected: string): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function operatorStatus(
  dependencies: Pick<OperatorDependencies, "stateService" | "storage">,
): Promise<HabitatStatusPayload> {
  const state = await dependencies.stateService.getState();
  const registration = state.registration;
  if (!registration?.habitatId) return state;
  const apiToken = await dependencies.storage.getRegistrationToken(registration.habitatId);
  return {
    ...state,
    registration: apiToken ? { ...registration, apiToken } : registration,
  };
}

export function createServerFetchHandler(dependencies: OperatorDependencies) {
  return async (request: Request, server: RequestIpServer): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== LOCAL_OPERATOR_STATUS_PATH) {
      return dependencies.appFetch(request);
    }

    const address = server.requestIP(request)?.address;
    if (
      request.method !== "GET" ||
      typeof address !== "string" ||
      !isLoopbackAddress(address) ||
      !hasOperatorCredential(request, dependencies.operatorToken)
    ) {
      return new Response("Not found", { status: 404 });
    }

    try {
      return Response.json(await operatorStatus(dependencies));
    } catch {
      return Response.json(
        { error: "Local Habitat status is unavailable." },
        { status: 500 },
      );
    }
  };
}
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
