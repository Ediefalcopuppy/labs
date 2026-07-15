export const views = ["Overview", "Habitat", "Modules", "Construction", "Inventory", "Blueprints", "Resources", "Solar & Power", "Settings"] as const;
export type View = typeof views[number];

const hashes: Record<View, string> = {
  Overview: "overview", Habitat: "habitat", Modules: "modules", Construction: "construction", Inventory: "inventory", Blueprints: "blueprints", Resources: "resources", "Solar & Power": "solar-power", Settings: "settings",
};

export function viewToHash(view: string): string { return `#/${hashes[view as View] ?? hashes.Overview}`; }
export function routeFromHash(hash: string): View { const entry = Object.entries(hashes).find(([, value]) => `#/${value}` === hash); return (entry?.[0] as View | undefined) ?? "Overview"; }
