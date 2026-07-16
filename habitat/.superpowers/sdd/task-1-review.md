diff --git a/habitat/src/kepler/service.ts b/habitat/src/kepler/service.ts
index e22ce46..5eebb3d 100644
--- a/habitat/src/kepler/service.ts
+++ b/habitat/src/kepler/service.ts
@@ -2,16 +2,18 @@ import { fetchKeplerJson } from "./client";
 
 export type KeplerHabitat = {
   id: string;
   habitatSlug: string;
   displayName: string;
   catalogVersion: string;
   status: string;
   lastSeenAt?: string | null;
+  starterHumans?: unknown;
+  contacts?: unknown;
 };
 
 type KeplerHabitatResponse = {
   habitat?: Partial<KeplerHabitat>;
 };
 
 type KeplerHabitatDetailsResponse = {
   habitat?: Record<string, unknown>;
@@ -111,16 +113,18 @@ function normalizeKeplerHabitat(value: Partial<KeplerHabitat>): KeplerHabitat {
     habitatSlug: value.habitatSlug,
     displayName: value.displayName,
     catalogVersion: value.catalogVersion,
     status: value.status,
     lastSeenAt:
       typeof value.lastSeenAt === "string" || value.lastSeenAt === null
         ? value.lastSeenAt
         : undefined,
+    starterHumans: value.starterHumans,
+    contacts: value.contacts,
   };
 }
 
 export function normalizeKeplerCatalog(
   entries: Array<Partial<KeplerBlueprintCatalogEntry> & { id?: string }>,
 ): KeplerBlueprintCatalogEntry[] {
   return entries.map((entry) => {
     const blueprintId = entry.blueprintId ?? entry.id;
diff --git a/habitat/src/state/service.ts b/habitat/src/state/service.ts
index e1500d1..897033e 100644
--- a/habitat/src/state/service.ts
+++ b/habitat/src/state/service.ts
@@ -2,37 +2,44 @@ import { readStateFromStorage, writeStateToStorage } from "./storage";
 import type {
   Airlock,
   ConstructionJob,
   Door,
   HabitatInventory,
   HabitatPowerTick,
   HabitatRegistration,
   HabitatState,
+  HabitatAlert,
+  HabitatHuman,
+  EvaState,
   PartialHabitatState,
   StarterModuleInstance,
   Zone,
 } from "./types";
 
 type StateServiceOptions = {
   storagePath: string;
 };
 
 const EMPTY_POWER: HabitatPowerTick = { powerConsumedTicks: 0 };
+const EMPTY_EVA: EvaState = { deployed: false, x: 0, y: 0, carriedResources: {} };
 
 export function createEmptyState(): HabitatState {
   return {
     zones: [],
     airlocks: [],
     doors: [],
     modules: [],
     blueprints: [],
     inventory: {},
     constructionJobs: [],
     power: { ...EMPTY_POWER },
+    humans: [],
+    eva: { ...EMPTY_EVA, carriedResources: {} },
+    alerts: [],
   };
 }
 
 function normalizeInventory(inventory: unknown): HabitatInventory {
   if (!inventory || typeof inventory !== "object") {
     return {};
   }
 
@@ -83,19 +90,55 @@ function normalizeRegistration(registration: unknown): HabitatRegistration | und
     remoteStatus:
       typeof candidate.remoteStatus === "string" && candidate.remoteStatus.length > 0
         ? candidate.remoteStatus
         : undefined,
     lastSeenAt:
       typeof candidate.lastSeenAt === "string" || candidate.lastSeenAt === null
         ? candidate.lastSeenAt
         : undefined,
+    starterHumans: candidate.starterHumans,
+    contacts: candidate.contacts,
   };
 }
 
+function normalizeHumans(humans: unknown): HabitatHuman[] {
+  if (!Array.isArray(humans)) return [];
+  return humans.filter((human): human is HabitatHuman => {
+    const id = human && typeof human === "object" ? (human as Record<string, unknown>).id : undefined;
+    return Boolean(
+      human &&
+        typeof human === "object" &&
+        typeof id === "string" &&
+        id.length > 0,
+    );
+  });
+}
+
+function normalizeEva(eva: unknown): EvaState {
+  if (!eva || typeof eva !== "object") return { ...EMPTY_EVA, carriedResources: {} };
+  const candidate = eva as Partial<EvaState>;
+  return {
+    deployed: typeof candidate.deployed === "boolean" ? candidate.deployed : false,
+    humanId: typeof candidate.humanId === "string" && candidate.humanId.length > 0 ? candidate.humanId : undefined,
+    x: typeof candidate.x === "number" && Number.isInteger(candidate.x) ? candidate.x : 0,
+    y: typeof candidate.y === "number" && Number.isInteger(candidate.y) ? candidate.y : 0,
+    carriedResources: normalizeInventory(candidate.carriedResources),
+  };
+}
+
+function normalizeAlerts(alerts: unknown): HabitatAlert[] {
+  if (!Array.isArray(alerts)) return [];
+  return alerts.filter((alert): alert is HabitatAlert => {
+    if (!alert || typeof alert !== "object") return false;
+    const candidate = alert as Record<string, unknown>;
+    return typeof candidate.id === "string" && candidate.id.length > 0 && typeof candidate.status === "string";
+  });
+}
+
 export function normalizeState(state: unknown): HabitatState {
   if (state === null || typeof state !== "object") {
     return createEmptyState();
   }
 
   const candidate = state as PartialHabitatState;
   return {
     zones: Array.isArray(candidate.zones) ? (candidate.zones as Zone[]) : [],
@@ -112,16 +155,19 @@ export function normalizeState(state: unknown): HabitatState {
         ? {
             powerConsumedTicks:
               typeof candidate.power.powerConsumedTicks === "number" &&
               Number.isFinite(candidate.power.powerConsumedTicks)
                 ? candidate.power.powerConsumedTicks
                 : 0,
           }
         : { ...EMPTY_POWER },
+    humans: normalizeHumans(candidate.humans),
+    eva: normalizeEva(candidate.eva),
+    alerts: normalizeAlerts(candidate.alerts),
     registration: normalizeRegistration(candidate.registration),
   };
 }
 
 export function createStateService(options: StateServiceOptions) {
   return {
     async getState(): Promise<HabitatState> {
       const stored = await readStateFromStorage(options.storagePath);
diff --git a/habitat/src/state/types.ts b/habitat/src/state/types.ts
index d7ca378..8918750 100644
--- a/habitat/src/state/types.ts
+++ b/habitat/src/state/types.ts
@@ -1,10 +1,36 @@
 export type HabitatInventory = Record<string, number>;
 
+export type HabitatHuman = {
+  id: string;
+  name?: string;
+  moduleId?: string;
+  x?: number;
+  y?: number;
+  status?: string;
+  [key: string]: unknown;
+};
+
+export type EvaState = {
+  deployed: boolean;
+  humanId?: string;
+  x: number;
+  y: number;
+  carriedResources: HabitatInventory;
+};
+
+export type HabitatAlert = {
+  id: string;
+  status: "open" | "acknowledged" | string;
+  message?: string;
+  severity?: string;
+  [key: string]: unknown;
+};
+
 export type HabitatPowerTick = {
   powerConsumedTicks: number;
 };
 
 export type StarterModuleInstance = {
   id: string;
   name: string;
   blueprintId: string;
@@ -48,24 +74,30 @@ export type HabitatRegistration = {
   displayName: string;
   registeredAt: string;
   lastSyncedAt: string;
   habitatId?: string;
   habitatSlug?: string;
   catalogVersion?: string;
   remoteStatus?: string;
   lastSeenAt?: string | null;
+  /** Kepler-owned registration fields, retained without narrowing their shape. */
+  starterHumans?: unknown;
+  contacts?: unknown;
 };
 
 export type HabitatState = {
   zones: Zone[];
   airlocks: Airlock[];
   doors: Door[];
   modules: StarterModuleInstance[];
   blueprints: KeplerBlueprintCatalogEntry[];
   inventory: HabitatInventory;
   constructionJobs: ConstructionJob[];
   power: HabitatPowerTick;
+  humans: HabitatHuman[];
+  eva: EvaState;
+  alerts: HabitatAlert[];
   registration?: HabitatRegistration;
 };
 
 export type PartialHabitatState = Partial<HabitatState>;
 import type { KeplerBlueprintCatalogEntry } from "../kepler/service";
# Task 1 Review: State models and normalization

Spec: ✅

Quality: ✅

Findings:

- P2 (non-blocking): `starterHumans` and `contacts` are intentionally typed as `unknown`, and human/alert records retain open index signatures. This preserves forward compatibility with Kepler payloads, but route/CLI code must validate fields at its boundary before using them. The task report calls out this design explicitly, so it is acceptable for this task.
- P2 (non-blocking): `task-1-report.md` contains an unrelated server-task section before the state-model report. This does not affect runtime behavior, but it makes the task record harder to audit.

Verification:

- `bunx tsc -p tsconfig.json --noEmit` passed.
- Existing state and Kepler tests passed (`bun test test/state-service.test.ts test/kepler-service.test.ts`).
- Legacy state without `humans`, `eva`, or `alerts` normalizes to empty collections and a docked EVA at `(0, 0)`.
- Registration detail fetching returns the Kepler response without normalizing or dropping fields.

Approval: approved for integration. No blocking spec or correctness issues found.
