diff --git a/habitat/src/index.ts b/habitat/src/index.ts
index 6182348..1e8aba8 100755
--- a/habitat/src/index.ts
+++ b/habitat/src/index.ts
@@ -140,16 +140,21 @@ function formatRegistrationDetails(payload: {
     lines.push(`${paint("  display name:", color.bold, color.cyan)} ${paint(registration.displayName, color.green)}`);
     lines.push(`${paint("  registered at:", color.bold, color.cyan)} ${paint(registration.registeredAt, color.green)}`);
     lines.push(`${paint("  last synced at:", color.bold, color.cyan)} ${paint(registration.lastSyncedAt, color.green)}`);
     if (registration.habitatId) lines.push(`${paint("  habitat id:", color.bold, color.cyan)} ${paint(registration.habitatId, color.green)}`);
     if (registration.habitatSlug) lines.push(`${paint("  habitat slug:", color.bold, color.cyan)} ${paint(registration.habitatSlug, color.green)}`);
     if (registration.catalogVersion) lines.push(`${paint("  catalog version:", color.bold, color.cyan)} ${paint(registration.catalogVersion, color.green)}`);
     if (registration.remoteStatus) lines.push(`${paint("  remote status:", color.bold, color.cyan)} ${paint(registration.remoteStatus, color.green)}`);
     if (registration.lastSeenAt) lines.push(`${paint("  last seen at:", color.bold, color.cyan)} ${paint(registration.lastSeenAt, color.green)}`);
+    for (const [key, value] of [["starter humans", registration.starterHumans], ["contacts", registration.contacts]] as const) {
+      if (value === undefined) continue;
+      lines.push(`${paint(`  ${key}:`, color.bold, color.cyan)}`);
+      lines.push(...formatObjectLines(value, 4));
+    }
   }
 
   if (kepler && typeof kepler === "object") {
     lines.push(`${paint("Live Kepler habitat payload:", color.bold, color.cyan)}`);
     for (const [key, value] of Object.entries(kepler as Record<string, unknown>)) {
       if (value === undefined) {
         continue;
       }
@@ -2281,16 +2286,134 @@ const scanCommand = new Command("scan")
 
     for (const line of formatScanResult(scan)) {
       console.log(line);
     }
   });
 
 program.addCommand(scanCommand);
 
+function printBackendPayload(payload: unknown, json = false): void {
+  if (json) {
+    console.log(JSON.stringify(payload, null, 2));
+    return;
+  }
+
+  for (const line of formatObjectLines(payload)) {
+    console.log(line);
+  }
+}
+
+const humanCommand = new Command("human")
+  .description("Manage habitat humans.")
+  .showHelpAfterError("Try 'habitat human --help' to see human commands.");
+
+humanCommand
+  .command("list")
+  .description("List humans and their locations.")
+  .option("--json", "print the complete JSON response")
+  .action(async (options: { json?: boolean }) => {
+    const humans = await getBackendCommand<unknown>("/commands/human/list");
+    printBackendPayload(humans, options.json);
+  });
+
+humanCommand
+  .command("move")
+  .description("Move a human into a module.")
+  .argument("<human-id>", "human id")
+  .argument("<module-id>", "destination module id")
+  .action(async (humanId: string, moduleId: string) => {
+    const result = await postBackendCommand<unknown>("/commands/human/move", { humanId, moduleId });
+    console.log(`Moved human '${humanId}' to module '${moduleId}'.`);
+    if (result && typeof result === "object" && "humans" in result) {
+      const human = (result as { humans?: Array<{ id?: string; moduleId?: string }> }).humans?.find((candidate) => candidate.id === humanId);
+      if (human) console.log(`Current module: ${human.moduleId ?? moduleId}`);
+    }
+  });
+
+program.addCommand(humanCommand);
+
+const evaCommand = new Command("eva")
+  .description("Manage the EVA explorer.")
+  .showHelpAfterError("Try 'habitat eva --help' to see EVA commands.");
+
+evaCommand
+  .command("status")
+  .description("Show explorer position and carried resources.")
+  .option("--json", "print the complete JSON response")
+  .action(async (options: { json?: boolean }) => {
+    const eva = await getBackendCommand<unknown>("/commands/eva/status");
+    printBackendPayload(eva, options.json);
+  });
+
+evaCommand
+  .command("deploy")
+  .description("Deploy one human from the suitport.")
+  .argument("<human-id>", "human id")
+  .action(async (humanId: string) => {
+    await postBackendCommand<unknown>("/commands/eva/deploy", { humanId });
+    console.log(`Deployed EVA for human '${humanId}'.`);
+  });
+
+evaCommand
+  .command("move")
+  .description("Move the EVA one adjacent grid tile.")
+  .argument("<x>", "destination x coordinate", (value) => parseInteger(value, "x"))
+  .argument("<y>", "destination y coordinate", (value) => parseInteger(value, "y"))
+  .action(async (x: number, y: number) => {
+    const eva = await postBackendCommand<unknown>("/commands/eva/move", { x, y });
+    console.log(`Moved EVA to (${x}, ${y}).`);
+    if (eva && typeof eva === "object" && "x" in eva && "y" in eva) {
+      console.log(`Position: (${String((eva as { x: unknown }).x)}, ${String((eva as { y: unknown }).y)})`);
+    }
+  });
+
+evaCommand
+  .command("dock")
+  .description("Dock at (0, 0) and unload carried resources.")
+  .action(async () => {
+    await postBackendCommand<unknown>("/commands/eva/dock");
+    console.log("Docked EVA at (0, 0) and unloaded carried resources.");
+  });
+
+program.addCommand(evaCommand);
+
+program
+  .command("collect")
+  .description("Collect material at the current EVA position.")
+  .argument("<quantity-kg>", "quantity in kilograms", parseInventoryAmount)
+  .action(async (quantityKg: number) => {
+    await postBackendCommand<unknown>("/commands/collect", { quantityKg });
+    console.log(`Collected ${quantityKg} kg.`);
+  });
+
+const alertCommand = new Command("alert")
+  .description("Inspect and acknowledge habitat alerts.")
+  .showHelpAfterError("Try 'habitat alert --help' to see alert commands.");
+
+alertCommand
+  .command("list")
+  .description("List persisted alerts and their statuses.")
+  .option("--json", "print the complete JSON response")
+  .action(async (options: { json?: boolean }) => {
+    const alerts = await getBackendCommand<unknown>("/commands/alert/list");
+    printBackendPayload(alerts, options.json);
+  });
+
+alertCommand
+  .command("acknowledge")
+  .description("Acknowledge one alert.")
+  .argument("<alert-id>", "alert id")
+  .action(async (alertId: string) => {
+    await postBackendCommand<unknown>(`/commands/alert/${encodeURIComponent(alertId)}/acknowledge`);
+    console.log(`Acknowledged alert '${alertId}'.`);
+  });
+
+program.addCommand(alertCommand);
+
 const inventoryCommand = new Command("inventory")
   .description("Manage habitat inventory.")
   .showHelpAfterError("Try 'habitat inventory --help' to see inventory commands.")
   .addHelpText(
     "after",
     `
 Commands:
   habitat inventory list
# Task 3 review: CLI command wiring

## Spec

✅ All requested new Commander commands are present:

- `human list`, `human move <human-id> <module-id>`
- `eva status`, `eva deploy <human-id>`, `eva move <x> <y>`, `eva dock`
- `collect <quantity-kg>`
- `alert list`, `alert acknowledge <alert-id>`

✅ New command actions use `getBackendCommand`/`postBackendCommand`; no direct state-storage or Kepler transport was added to these handlers.

✅ Existing integer and quantity parsers are used for EVA coordinates and collection quantity. List/status commands expose `--json`.

✅ Registration details retain and render `starterHumans` and `contacts` (including nested `contacts.alerts`) and still print the complete live Kepler payload in JSON mode.

## Verification

✅ `bunx tsc -p tsconfig.json --noEmit`

✅ Commander help checks for `human`, `human list`, `eva`, `alert`, and `collect`.

## Quality

✅ Formatting follows the existing `paint`/`formatObjectLines` conventions. Mutation commands intentionally print concise success messages while transport remains in backend helpers.

## Findings

No blocking or major findings. The backend returns full state for several mutation routes, while the CLI intentionally consumes only the fields it needs; this is compatible with the transport-focused scope.

## Approval

Spec: ✅  Quality: ✅  Approval: ✅
