import type { StarterModuleInstance } from "../state/types";

export type HabitatModule = StarterModuleInstance;

export function createUniqueModuleName(displayName: string, existingNames: string[]): string {
  const baseName = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const normalizedBase = baseName.length > 0 ? baseName : "module";
  let suffix = 1;

  while (existingNames.includes(`${normalizedBase}-${suffix}`)) {
    suffix += 1;
  }

  return `${normalizedBase}-${suffix}`;
}

export function normalizeModuleNames<T extends HabitatModule>(modules: T[]): T[] {
  const usedNames = new Set(
    modules
      .map((module) => (typeof module.name === "string" ? module.name.trim().toLowerCase() : ""))
      .filter((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/.test(name)),
  );

  return modules.map((module) => {
    const sourceName =
      typeof module.name === "string" && module.name.trim().length > 0
        ? module.name
        : typeof module.displayName === "string" && module.displayName.trim().length > 0
          ? module.displayName
          : module.blueprintId || module.id;
    const normalizedName = sourceName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "module";
    const suffixMatch = normalizedName.match(/^(.*)-(\d+)$/);
    const baseName = suffixMatch?.[1] || normalizedName;
    const currentNameIsAvailable = suffixMatch !== null && usedNames.has(normalizedName);
    if (currentNameIsAvailable) {
      usedNames.delete(normalizedName);
    }
    const name = currentNameIsAvailable ? normalizedName : createUniqueModuleName(baseName, [...usedNames]);

    usedNames.add(name);
    return { ...module, name };
  });
}

export function moduleStatus(module: HabitatModule): string {
  const state = module.runtimeAttributes.state ?? module.runtimeAttributes.status;
  return typeof state === "string" && state.length > 0 ? state : "online";
}

export function setModuleStatus<T extends HabitatModule>(module: T, status: string): T {
  return {
    ...module,
    runtimeAttributes: {
      ...module.runtimeAttributes,
      state: status,
      status,
    },
  };
}
