import "./styles.css";
import "./ripple.css";

type State = {
  registration?: { displayName: string; habitatId?: string; remoteStatus?: string; lastSyncedAt?: string };
  modules: Array<{ id: string; name: string; displayName: string; blueprintId: string; runtimeAttributes: Record<string, unknown>; capabilities: string[] }>;
  blueprints: Array<{ blueprintId: string; displayName?: string; inputs?: Record<string, number>; ticks?: number }>;
  inventory: Record<string, number>;
  constructionJobs: Array<{ id: string; moduleName: string; blueprintId: string; remainingBuildTicks: number; totalBuildTicks: number }>;
  power: { powerConsumedTicks: number };
};

type Command = { id: string; title: string; group: string; description: string; method: "GET" | "POST" | "DELETE"; path: string; fields?: Array<{ name: string; label: string; type?: string; placeholder?: string }> };

const commands: Command[] = [
  { id: "status", title: "Habitat status", group: "Habitat", description: "Inspect registration, module counts, and power.", method: "GET", path: "/commands/status" },
  { id: "register", title: "Register habitat", group: "Habitat", description: "Create a local habitat registration.", method: "POST", path: "/commands/register", fields: [{ name: "name", label: "Habitat name", placeholder: "Artemis Ridge" }] },
  { id: "link", title: "Link habitat", group: "Habitat", description: "Link this workspace to a remote habitat.", method: "POST", path: "/commands/link", fields: [{ name: "id", label: "Habitat ID", placeholder: "hab_123456" }] },
  { id: "unregister", title: "Unregister habitat", group: "Habitat", description: "Remove the local registration.", method: "DELETE", path: "/commands/unregister" },
  { id: "solar", title: "Solar status", group: "Solar & Power", description: "Inspect live solar conditions.", method: "GET", path: "/commands/solar/status" },
  { id: "power", title: "Power overview", group: "Solar & Power", description: "Summarize power draw and module states.", method: "GET", path: "/commands/power/overview" },
  { id: "tick", title: "Run ticks", group: "Simulation", description: "Advance the habitat simulation.", method: "POST", path: "/commands/tick", fields: [{ name: "count", label: "Tick count", type: "number", placeholder: "1" }] },
  { id: "blueprints", title: "List blueprints", group: "Blueprints", description: "Refresh the remote blueprint catalog.", method: "GET", path: "/commands/blueprint/list" },
  { id: "resources", title: "List resources", group: "Resources", description: "Load the resource catalog.", method: "GET", path: "/commands/resource/list" },
  { id: "scan", title: "Scan resources", group: "Resources", description: "Scan a world location for resources.", method: "POST", path: "/commands/resource/scan", fields: [{ name: "x", label: "X", type: "number", placeholder: "0" }, { name: "y", label: "Y", type: "number", placeholder: "0" }, { name: "sensorStrength", label: "Sensor strength", type: "number", placeholder: "50" }, { name: "radiusTiles", label: "Radius", type: "number", placeholder: "0" }] },
  { id: "inventory-set", title: "Set inventory", group: "Inventory", description: "Set a resource quantity.", method: "POST", path: "/commands/inventory/set", fields: [{ name: "resourceId", label: "Resource ID", placeholder: "basalt-composite" }, { name: "amount", label: "Amount", type: "number", placeholder: "500" }] },
  { id: "construct", title: "Construct module", group: "Construction", description: "Start construction from a blueprint.", method: "POST", path: "/commands/construct", fields: [{ name: "blueprintId", label: "Blueprint ID", placeholder: "greenhouse" }, { name: "displayName", label: "Display name", placeholder: "Greenhouse" }] },
  { id: "jobs", title: "List construction", group: "Construction", description: "Inspect active construction jobs.", method: "GET", path: "/commands/construction/list" },
  { id: "modules", title: "List modules", group: "Modules", description: "Inspect all habitat modules.", method: "GET", path: "/commands/module/list" },
  { id: "module-status", title: "Module status", group: "Modules", description: "Inspect module runtime status.", method: "GET", path: "/commands/module/status" },
  { id: "module-create", title: "Create module", group: "Modules", description: "Create a module from a blueprint.", method: "POST", path: "/commands/module/create", fields: [{ name: "blueprintId", label: "Blueprint ID", placeholder: "greenhouse" }, { name: "displayName", label: "Display name", placeholder: "Greenhouse" }] },
  { id: "module-set-status", title: "Set module status", group: "Modules", description: "Change a module runtime status.", method: "POST", path: "/commands/module/set-status", fields: [{ name: "moduleId", label: "Module ID", placeholder: "greenhouse-1" }, { name: "status", label: "Status", placeholder: "online" }] },
  { id: "module-show", title: "Show module", group: "Modules", description: "Inspect one module by name.", method: "GET", path: "/commands/module/{name}", fields: [{ name: "name", label: "Module name", placeholder: "greenhouse-1" }] },
  { id: "module-update", title: "Update module", group: "Modules", description: "Rename or update a module status.", method: "POST", path: "/commands/module/{name}", fields: [{ name: "name", label: "Module name", placeholder: "greenhouse-1" }, { name: "status", label: "New status", placeholder: "online" }] },
  { id: "module-delete", title: "Delete module", group: "Modules", description: "Remove a module from local state.", method: "DELETE", path: "/commands/module/{name}", fields: [{ name: "name", label: "Module name", placeholder: "greenhouse-1" }] },
  { id: "blueprint-show", title: "Show blueprint", group: "Blueprints", description: "Inspect one blueprint.", method: "GET", path: "/commands/blueprint/{blueprintId}", fields: [{ name: "blueprintId", label: "Blueprint ID", placeholder: "greenhouse" }] },
  { id: "inventory-list", title: "List inventory", group: "Inventory", description: "Inspect local resource quantities.", method: "GET", path: "/commands/inventory/list" },
  { id: "construction-status", title: "Construction status", group: "Construction", description: "Inspect current construction status.", method: "GET", path: "/commands/construction/status" },
  { id: "construction-cancel", title: "Cancel construction", group: "Construction", description: "Cancel a construction job.", method: "DELETE", path: "/commands/construction/{jobId}", fields: [{ name: "jobId", label: "Job ID", placeholder: "job_123" }] },
  { id: "debug-construct", title: "Debug construct", group: "Debug", description: "Force a construction plan for diagnostics.", method: "POST", path: "/commands/construct", fields: [{ name: "blueprintId", label: "Blueprint ID", placeholder: "greenhouse" }] },
  { id: "sqlite", title: "Rebuild SQLite", group: "Settings", description: "Rebuild SQLite state from current habitat state.", method: "POST", path: "/commands/storage/sqlite" },
  { id: "restore", title: "Restore backup", group: "Settings", description: "Restore the local data backup.", method: "POST", path: "/commands/storage/restore" },
  { id: "normalize", title: "Normalize module names", group: "Modules", description: "Repair module IDs and connections.", method: "POST", path: "/commands/module/normalize-names" },
  { id: "recharge", title: "Recharge batteries", group: "Debug", description: "Fill all battery modules.", method: "POST", path: "/commands/debug/recharge-batteries" },
  { id: "battery", title: "Battery drain", group: "Debug", description: "Inspect battery drain calculations.", method: "GET", path: "/commands/debug/battery-drain" },
];

const api = async (path: string, options: RequestInit = {}) => {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(typeof body === "object" && body && "message" in body ? String((body as { message: unknown }).message) : text || `Request failed (${response.status})`);
  return body;
};

let state: State = { modules: [], blueprints: [], inventory: {}, constructionJobs: [], power: { powerConsumedTicks: 0 } };
let activeView = "Overview";
let drawerOpen = false;
let query = "";
let apiOnline = false;

const icon = (name: string) => ({ grid: "⌂", habitat: "◉", modules: "▦", construction: "◒", inventory: "▤", blueprint: "◇", resources: "⌁", power: "ϟ", debug: "⚙", settings: "⚙" }[name] ?? "•");
const statusOf = (m: State["modules"][number]) => String(m.runtimeAttributes.state ?? m.runtimeAttributes.status ?? "offline");
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const humanizeKey = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\b(id|url|api|cpu|ram|w)\b/gi, (word) => word.toUpperCase()).replace(/\b\w/g, (letter) => letter.toUpperCase());
const domainLabel = (key: string) => ({ blueprintId: "Blueprint", displayName: "Name", moduleName: "Module", moduleId: "Module ID", jobId: "Job ID", remainingBuildTicks: "Ticks Remaining", totalBuildTicks: "Total Build Ticks", powerConsumedTicks: "Power Consumed", powerDraw: "Power Draw", runtimeAttributes: "Runtime", capabilities: "Capabilities", sensorStrength: "Sensor Strength", radiusTiles: "Scan Radius", resourceId: "Resource", amount: "Quantity" }[key] ?? humanizeKey(key));
const formatValue = (value: unknown, key = ""): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof value === "string") return esc(/At$|Date$|Timestamp$/i.test(key) && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : value);
  return "";
};
const isRecordArray = (value: unknown): value is Array<Record<string, unknown>> => Array.isArray(value) && value.length > 0 && value.every((item) => item && typeof item === "object" && !Array.isArray(item));
function readableResponse(value: unknown): string {
  if (value === null || value === undefined || value === "") return `<p class="result-empty">No response data.</p>`;
  if (typeof value !== "object") return `<div class="result-value">${formatValue(value)}</div>`;
  if (isRecordArray(value)) { const keys = [...new Set(value.flatMap((item) => Object.keys(item)))].slice(0, 6); return `<div class="result-table-wrap"><table class="result-table"><thead><tr>${keys.map((key) => `<th>${esc(domainLabel(key))}</th>`).join("")}</tr></thead><tbody>${value.map((item) => `<tr>${keys.map((key) => `<td>${formatResultCell(item[key], key)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`; }
  return `<div class="result-fields">${Object.entries(value as Record<string, unknown>).map(([key, item]) => `<div class="result-field"><span>${esc(domainLabel(key))}</span><strong>${formatResultCell(item, key)}</strong></div>`).join("")}</div>`;
}
function formatResultCell(value: unknown, key: string): string { if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === "object" ? readableResponse(item) : formatValue(item, key)).join(", ") : "—"; if (value && typeof value === "object") return `<details><summary>View details</summary>${readableResponse(value)}</details>`; return formatValue(value, key); }
function responseOutput(value: unknown): string { return `${readableResponse(value)}<details class="raw-result"><summary>Raw response</summary><pre>${esc(JSON.stringify(value, null, 2))}</pre></details>`; }
const labelFor = (key: string) => domainLabel(key);
function formatOutput(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (value === null || value === undefined) return `${pad}—`;
  if (typeof value !== "object") return `${pad}${String(value)}`;
  if (Array.isArray(value)) return value.length ? value.map((item) => `${pad}• ${formatOutput(item, indent + 2).trimStart()}`).join("\n") : `${pad}None`;
  return Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (item && typeof item === "object") return `${pad}${labelFor(key)}:\n${formatOutput(item, indent + 2)}`;
    return `${pad}${labelFor(key)}: ${formatOutput(item).trim()}`;
  }).join("\n");
}

async function refresh() {
  state = await api("/state") as State;
  apiOnline = true;
  render();
}

function metric(label: string, value: string | number, detail: string, tone = "blue") { return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value ${tone}">${esc(value)}</div><div class="metric-detail">${detail}</div></div>`; }
function card(title: string, eyebrow: string, content: string, action = "") { return `<section class="card"><div class="card-head"><div><div class="eyebrow">${eyebrow}</div><h2>${title}</h2></div>${action}</div>${content}</section>`; }

function overview() {
  const online = state.modules.filter((m) => ["online", "active", "idle"].includes(statusOf(m))).length;
  const registered = Boolean(state.registration);
  const content = !registered ? `<div class="onboarding"><div class="orb">⌂</div><div><h3>Connect your habitat</h3><p>Register a new habitat or link this workspace to an existing one to start operating.</p><button class="primary" data-command="register">Register habitat</button><button class="secondary" data-command="link">Link existing</button></div></div>` : `<div class="metrics">${metric("Modules online", `${online}/${state.modules.length}`, online ? "Operational capacity available" : "No active modules", online ? "green" : "amber")}${metric("Power consumed", state.power.powerConsumedTicks, "Simulation ticks", "purple")}${metric("Inventory lines", Object.keys(state.inventory).length, "Tracked resources")}${metric("Construction", state.constructionJobs.length, state.constructionJobs.length ? "Jobs in progress" : "No active jobs", state.constructionJobs.length ? "amber" : "green")}</div>`;
  const modules = state.modules.slice(0, 5).map((m) => `<tr><td><span class="module-dot ${statusOf(m)}"></span>${esc(m.displayName || m.name)}</td><td>${esc(m.blueprintId)}</td><td><span class="pill ${statusOf(m)}">${esc(statusOf(m))}</span></td><td>${esc(m.runtimeAttributes.powerDraw ?? 0)} W</td></tr>`).join("") || `<tr><td colspan="4" class="empty">No modules yet.</td></tr>`;
  return `<div class="page-title"><div><div class="eyebrow">HABITAT CONTROL</div><h1>Good morning${registered ? `, ${esc(state.registration?.displayName)}` : ""}</h1><p class="muted">Your habitat at a glance.</p></div><button class="primary" data-command="tick">Run simulation tick</button></div>${card("Overview", "LIVE STATUS", content)}${card("Module activity", "SYSTEMS", `<table><thead><tr><th>Module</th><th>Blueprint</th><th>Status</th><th>Draw</th></tr></thead><tbody>${modules}</tbody></table>`, `<button class="link" data-view="Modules">View all modules →</button>`)}`;
}

function domainView(view: string) {
  if (view === "Habitat") return overview();
  const maps: Record<string, { eyebrow: string; title: string; description: string; items: string; actions: string }> = {
    Modules: { eyebrow: "MODULES", title: "Module operations", description: "Manage the systems that keep your habitat running.", items: state.modules.map((m) => `<div class="list-row"><div><strong>${esc(m.displayName || m.name)}</strong><span class="subtle">${esc(m.blueprintId)} · ${esc(m.id)}</span></div><span class="pill ${statusOf(m)}">${esc(statusOf(m))}</span><button class="icon-button" data-module="${esc(m.id)}" title="Change status">⋮</button></div>`).join("") || `<div class="empty-state">No modules found.</div>`, actions: `<button class="primary" data-command="construct">Create module</button>` },
    Construction: { eyebrow: "CONSTRUCTION", title: "Build queue", description: "Track facilities currently under construction.", items: state.constructionJobs.map((j) => `<div class="list-row"><div><strong>${esc(j.moduleName)}</strong><span class="subtle">${esc(j.blueprintId)} · facility ${esc(j.id)}</span></div><div class="progress-wrap"><div class="progress"><span style="width:${Math.max(4, 100 - (j.remainingBuildTicks / Math.max(1, j.totalBuildTicks)) * 100)}%"></span></div><span>${j.remainingBuildTicks}/${j.totalBuildTicks} ticks</span></div><button class="danger-link" data-cancel="${esc(j.id)}">Cancel</button></div>`).join("") || `<div class="empty-state">Construction queue is clear.</div>`, actions: `<button class="primary" data-command="construct">Start construction</button><button class="secondary" data-command="tick">Run tick</button>` },
    Inventory: { eyebrow: "INVENTORY", title: "Resource inventory", description: "The materials currently available to your habitat.", items: Object.entries(state.inventory).map(([id, amount]) => `<div class="inventory-row"><span>${esc(id)}</span><strong>${amount.toLocaleString()}</strong></div>`).join("") || `<div class="empty-state">No inventory records yet.</div>`, actions: `<button class="primary" data-command="inventory-set">Set resource</button>` },
    Blueprints: { eyebrow: "BLUEPRINT CATALOG", title: "Blueprints", description: "Available module designs and their build requirements.", items: state.blueprints.map((b) => `<div class="list-row"><div><strong>${esc(b.displayName || b.blueprintId)}</strong><span class="subtle">${esc(b.blueprintId)} · ${b.ticks ?? "—"} ticks</span></div><span class="tag">${Object.keys(b.inputs ?? {}).length} inputs</span></div>`).join("") || `<div class="empty-state">Catalog is empty. Refresh to load blueprints.</div>`, actions: `<button class="primary" data-command="blueprints">Refresh catalog</button>` },
    Resources: { eyebrow: "RESOURCE CATALOG", title: "Resources", description: "Scan and inspect the world around your habitat.", items: `<div class="scan-grid"><label>X<input id="scan-x" type="number" value="0"></label><label>Y<input id="scan-y" type="number" value="0"></label><label>Sensor strength<input id="scan-strength" type="number" value="50"></label><label>Radius<input id="scan-radius" type="number" value="0"></label></div><div id="scan-output" class="scan-output">Run a scan to see candidate resources.</div>`, actions: `<button class="primary" data-command="resources">Refresh catalog</button><button class="secondary" id="scan-btn">Scan location</button>` },
    "Solar & Power": { eyebrow: "SOLAR & POWER", title: "Energy systems", description: "Live power conditions and stored simulation telemetry.", items: `<div class="metrics">${metric("Consumed ticks", state.power.powerConsumedTicks, "Total simulation cost", "purple")}${metric("Chargers", "—", "Refresh solar status for live data")}${metric("Current draw", `${state.modules.reduce((n, m) => n + (Number(m.runtimeAttributes.powerDraw) || 0), 0)} W`, "Across all modules", "amber")}</div>`, actions: `<button class="primary" data-command="solar">Refresh solar</button><button class="secondary" data-command="power">Refresh overview</button>` },
    Debug: { eyebrow: "DEBUG TOOLS", title: "Diagnostics", description: "Inspect and repair runtime systems.", items: commands.filter((c) => c.group === "Debug").map((c) => `<div class="list-row"><div><strong>${c.title}</strong><span class="subtle">${c.description}</span></div><button class="secondary" data-command="${c.id}">Run</button></div>`).join(""), actions: "" },
    Settings: { eyebrow: "SETTINGS", title: "Habitat settings", description: "Connection details and maintenance actions.", items: `<div class="setting-row"><div><strong>Connection</strong><span class="subtle">${registeredStatus()}</span></div><span class="pill green">Connected</span></div><div class="setting-row"><div><strong>Storage</strong><span class="subtle">SQLite state at .habitat/habitat.sqlite</span></div><button class="secondary" data-command="status">Inspect</button></div><div class="setting-row"><div><strong>Unregister habitat</strong><span class="subtle">Remove the local registration.</span></div><button class="danger" data-command="unregister">Unregister</button></div>`, actions: "" },
  };
  const model = maps[view] ?? maps.Modules;
  return `<div class="page-title"><div><div class="eyebrow">${model.eyebrow}</div><h1>${model.title}</h1><p class="muted">${model.description}</p></div><div class="actions">${model.actions}</div></div>${card(model.title, model.eyebrow, model.items)}`;
}
function registeredStatus() { return state.registration ? `${state.registration.displayName}${state.registration.habitatId ? ` · ${state.registration.habitatId}` : ""}` : "Not registered"; }

function render() {
  const nav = [{ id: "Overview", icon: "grid" }, { id: "Habitat", icon: "habitat" }, { id: "Modules", icon: "modules" }, { id: "Construction", icon: "construction" }, { id: "Inventory", icon: "inventory" }, { id: "Blueprints", icon: "blueprint" }, { id: "Resources", icon: "resources" }, { id: "Solar & Power", icon: "power" }, { id: "Debug", icon: "debug" }, { id: "Settings", icon: "settings" }];
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">⌂</span><span>Habitat</span></div><div class="workspace"><span class="workspace-avatar">${esc((state.registration?.displayName ?? "H").slice(0, 1).toUpperCase())}</span><span>${esc(state.registration?.displayName ?? "Local workspace")}</span><span class="chevron">⌄</span></div><nav>${nav.map((n) => `<button class="nav-item ${activeView === n.id ? "active" : ""}" data-view="${n.id}"><span class="nav-icon">${icon(n.icon)}</span>${n.id}</button>`).join("")}</nav><div class="sidebar-foot"><span class="status-dot ${apiOnline ? "" : "offline"}"></span><span>${apiOnline ? "Local API online" : "Local API unavailable"}</span><button class="icon-button" id="settings-shortcut">⚙</button></div></aside><main class="main"><header class="topbar"><div class="crumb"><span>Habitat</span><span class="slash">/</span><strong>${activeView}</strong></div><div class="top-actions"><button class="search-button" id="open-commands"><span>⌕</span> Search commands <kbd>⌘ K</kbd></button><button class="icon-button" id="refresh">↻</button><div class="profile">${esc((state.registration?.displayName ?? "H").slice(0, 1).toUpperCase())}</div></div></header><div class="content">${activeView === "Overview" ? overview() : domainView(activeView)}</div></main>${drawerOpen ? commandDrawer() : ""}<div id="toast" class="toast"></div></div>`;
  bindEvents();
}

function commandDrawer() { const filtered = commands.filter((c) => `${c.title} ${c.group} ${c.description}`.toLowerCase().includes(query.toLowerCase())); return `<div class="drawer-backdrop" id="drawer-close"></div><aside class="command-drawer"><div class="drawer-head"><div><div class="eyebrow">COMMAND CENTER</div><h2>Run a command</h2></div><button class="icon-button" id="drawer-x">×</button></div><input class="command-search" id="command-search" value="${esc(query)}" placeholder="Search commands…" autofocus><div class="command-list">${filtered.map((c) => `<button class="command-item" data-command="${c.id}"><span class="command-symbol">${icon(c.group === "Modules" ? "modules" : c.group === "Debug" ? "debug" : "grid")}</span><span><strong>${c.title}</strong><small>${c.group} · ${c.description}</small></span><span>›</span></button>`).join("") || `<div class="empty-state">No commands match your search.</div>`}</div></aside>`; }

function showCommand(command: Command) { const fields = command.fields?.map((f) => `<label>${f.label}<input name="${f.name}" type="${f.type ?? "text"}" placeholder="${f.placeholder ?? ""}" required></label>`).join("") ?? ""; const dialog = document.createElement("div"); dialog.className = "modal-backdrop"; dialog.innerHTML = `<form class="modal" id="command-form"><div class="eyebrow">${command.group}</div><h2>${command.title}</h2><p class="muted">${command.description}</p>${fields}<div class="modal-actions"><button type="button" class="secondary" id="modal-cancel">Cancel</button><button class="primary">Run command</button></div><pre class="result" id="modal-result"></pre></form>`; document.body.append(dialog); dialog.querySelector("#modal-cancel")!.addEventListener("click", () => dialog.remove()); dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.remove(); }); dialog.querySelector("form")!.addEventListener("submit", async (e) => { e.preventDefault(); const form = e.currentTarget as HTMLFormElement; const result = form.querySelector("#modal-result")!; const values = Object.fromEntries(new FormData(form).entries()); Object.keys(values).forEach((key) => { if (["count", "x", "y", "sensorStrength", "radiusTiles", "amount"].includes(key)) values[key] = Number(values[key]); }); const path = command.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(String(values[key] ?? ""))); const pathKey = command.path.match(/\{([^}]+)\}/)?.[1]; if (pathKey) delete (values as Record<string, unknown>)[pathKey]; result.textContent = "Running…"; try { const output = await api(path, { method: command.method, body: command.method === "POST" ? JSON.stringify(values) : undefined }); result.textContent = formatOutput(output); await refresh(); } catch (error) { result.textContent = error instanceof Error ? error.message : String(error); } }); }

function toast(message: string) { const node = document.querySelector<HTMLDivElement>("#toast"); if (!node) return; node.textContent = message; node.classList.add("show"); setTimeout(() => node.classList.remove("show"), 2800); }
function bindEvents() { document.querySelectorAll<HTMLElement>("[data-view]").forEach((el) => el.addEventListener("click", () => { activeView = el.dataset.view!; render(); })); document.querySelectorAll<HTMLElement>("[data-command]").forEach((el) => el.addEventListener("click", () => { const command = commands.find((c) => c.id === el.dataset.command); if (command) { drawerOpen = false; showCommand(command); } })); document.querySelector("#refresh")?.addEventListener("click", () => refresh().catch((e) => toast(e.message))); document.querySelector("#open-commands")?.addEventListener("click", () => { drawerOpen = true; render(); }); document.querySelector("#settings-shortcut")?.addEventListener("click", () => { activeView = "Settings"; render(); }); document.querySelector("#drawer-close")?.addEventListener("click", () => { drawerOpen = false; render(); }); document.querySelector("#drawer-x")?.addEventListener("click", () => { drawerOpen = false; render(); }); document.querySelector<HTMLInputElement>("#command-search")?.addEventListener("input", (e) => { query = (e.target as HTMLInputElement).value; render(); }); document.querySelector("#scan-btn")?.addEventListener("click", async () => { const values = { x: Number((document.querySelector("#scan-x") as HTMLInputElement).value), y: Number((document.querySelector("#scan-y") as HTMLInputElement).value), sensorStrength: Number((document.querySelector("#scan-strength") as HTMLInputElement).value), radiusTiles: Number((document.querySelector("#scan-radius") as HTMLInputElement).value) }; try { const output = await api("/commands/resource/scan", { method: "POST", body: JSON.stringify(values) }); document.querySelector("#scan-output")!.textContent = formatOutput(output); } catch (e) { toast(e instanceof Error ? e.message : String(e)); } }); document.querySelectorAll<HTMLElement>("[data-cancel]").forEach((el) => el.addEventListener("click", async () => { if (!confirm("Cancel this construction job?")) return; try { await api(`/commands/construction/${el.dataset.cancel}`, { method: "DELETE" }); toast("Construction job cancelled"); await refresh(); } catch (e) { toast(e instanceof Error ? e.message : String(e)); } })); }

document.addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); drawerOpen = true; render(); } });
document.addEventListener("pointerdown", (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button, .command-item, .nav-item, .list-row") : null;
  if (!target || target.hasAttribute("disabled")) return;
  const bounds = target.getBoundingClientRect();
  const pulse = document.createElement("span");
  pulse.className = "click-ripple";
  pulse.style.left = `${event.clientX - bounds.left}px`;
  pulse.style.top = `${event.clientY - bounds.top}px`;
  target.appendChild(pulse);
  pulse.addEventListener("animationend", () => pulse.remove(), { once: true });
});
refresh().catch((error) => { apiOnline = false; toast(error instanceof Error ? error.message : String(error)); render(); });
