export type CommandField = { name: string; type?: "number" | "text" };
export type Command = { id: string; method: "GET" | "POST" | "DELETE"; path: string; fields?: CommandField[] };

const commandList: Command[] = [
  { id: "module-show", method: "GET", path: "/commands/module/{name}", fields: [{ name: "name" }] },
  { id: "scan", method: "POST", path: "/commands/resource/scan", fields: [{ name: "x", type: "number" }, { name: "y", type: "number" }, { name: "sensorStrength", type: "number" }, { name: "radiusTiles", type: "number" }] },
];

export function getCommandById(id: string): Command { const command = commandList.find((item) => item.id === id); if (!command) throw new Error(`Unknown command '${id}'.`); return command; }
export function buildCommandRequest(command: Command, values: Record<string, string | number>): { path: string; body?: Record<string, unknown> } {
  let path = command.path;
  const body: Record<string, unknown> = {};
  for (const field of command.fields ?? []) {
    const value = values[field.name];
    if (path.includes(`{${field.name}}`)) path = path.replace(`{${field.name}}`, encodeURIComponent(String(value ?? "")));
    else body[field.name] = field.type === "number" ? Number(value) : value;
  }
  return Object.keys(body).length ? { path, body } : { path };
}
