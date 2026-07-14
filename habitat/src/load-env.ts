import { join } from "node:path";

const envFiles = [".env"];
const projectRoot = join(import.meta.dir, "..");

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }

  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex <= 0) {
    return null;
  }

  const key = trimmed.slice(0, equalsIndex).trim();
  if (!key) {
    return null;
  }

  let value = trimmed.slice(equalsIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return [key, value];
}

function applyEnvFile(contents: string): void {
  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }

    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

for (const file of envFiles) {
  const envPath = Bun.file(join(projectRoot, file));
  if (!envPath.exists()) {
    continue;
  }

  const contents = await envPath.text();
  applyEnvFile(contents);
}

export {};
