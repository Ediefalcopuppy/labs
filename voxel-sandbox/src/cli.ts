import { startTerminalMode } from "./terminal";

const args = new Set(process.argv.slice(2));

if (args.has("-i") || args.has("--interactive")) {
  await startTerminalMode();
} else {
  console.log("Voxel Sandbox");
  console.log("");
  console.log("Browser mode:");
  console.log("  bun run dev");
  console.log("");
  console.log("Terminal mode:");
  console.log("  bun run start -- -i");
}
