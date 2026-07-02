type BlockId = "grass" | "dirt" | "stone" | "sand" | "wood" | "leaves" | "water";

type BlockDefinition = {
  label: string;
  glyph: string;
  color: string;
  solid: boolean;
};

type Target = {
  x: number;
  y: number;
  z: number;
  previousX: number;
  previousY: number;
  previousZ: number;
};

const WORLD_RADIUS = 24;
const MIN_Y = -4;
const MAX_Y = 22;
const WATER_LEVEL = 1;
const VIEW_WIDTH = 76;
const VIEW_HEIGHT = 24;
const FOV = Math.PI / 2.45;
const REACH = 7;
const MAX_VIEW_DISTANCE = 30;

const ansi = {
  clear: "\x1b[2J",
  home: "\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  inverse: "\x1b[7m",
};

const blockDefinitions: Record<BlockId, BlockDefinition> = {
  grass: { label: "Grass", glyph: "#", color: "\x1b[38;5;77m", solid: true },
  dirt: { label: "Dirt", glyph: "%", color: "\x1b[38;5;130m", solid: true },
  stone: { label: "Stone", glyph: "O", color: "\x1b[38;5;245m", solid: true },
  sand: { label: "Sand", glyph: "=", color: "\x1b[38;5;222m", solid: true },
  wood: { label: "Wood", glyph: "H", color: "\x1b[38;5;94m", solid: true },
  leaves: { label: "Leaves", glyph: "*", color: "\x1b[38;5;34m", solid: true },
  water: { label: "Water", glyph: "~", color: "\x1b[38;5;39m", solid: false },
};

const palette: BlockId[] = ["grass", "dirt", "stone", "sand", "wood", "leaves", "water"];
const blocks = new Map<string, BlockId>();

let selectedBlockIndex = 0;
let yaw = Math.PI;
let pitch = -0.1;
let running = true;

const player = {
  x: 0,
  y: 5,
  z: 0,
};

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function getBlock(x: number, y: number, z: number): BlockId | undefined {
  return blocks.get(key(x, y, z));
}

function setBlock(x: number, y: number, z: number, block: BlockId): void {
  blocks.set(key(x, y, z), block);
}

function removeBlock(x: number, y: number, z: number): void {
  blocks.delete(key(x, y, z));
}

function pseudoRandom(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function terrainHeight(x: number, z: number): number {
  const rolling = Math.sin(x * 0.25) * 1.4 + Math.cos(z * 0.21) * 1.2;
  const hills = Math.sin((x + z) * 0.12) * 1.8 + Math.cos((x - z) * 0.17) * 1.35;
  const detail = pseudoRandom(x * 15.31 + z * 91.7) * 1.7;
  return Math.floor(2 + rolling + hills + detail);
}

function createTree(x: number, groundY: number, z: number): void {
  const height = 3 + Math.floor(pseudoRandom(x * 3.9 + z * 8.1) * 3);

  for (let y = groundY + 1; y <= groundY + height; y += 1) {
    setBlock(x, y, z, "wood");
  }

  const leafCenter = groundY + height;
  for (let lx = -2; lx <= 2; lx += 1) {
    for (let ly = -1; ly <= 2; ly += 1) {
      for (let lz = -2; lz <= 2; lz += 1) {
        const distance = Math.abs(lx) + Math.abs(lz) + Math.max(0, ly - 1);
        if (distance <= 3 && pseudoRandom((x + lx) * 5.1 + (z + lz) * 9.7 + ly) > 0.12) {
          setBlock(x + lx, leafCenter + ly, z + lz, "leaves");
        }
      }
    }
  }
}

function generateWorld(): void {
  blocks.clear();

  for (let x = -WORLD_RADIUS; x <= WORLD_RADIUS; x += 1) {
    for (let z = -WORLD_RADIUS; z <= WORLD_RADIUS; z += 1) {
      const height = terrainHeight(x, z);

      for (let y = MIN_Y; y <= height; y += 1) {
        const block: BlockId =
          y === height ? (height <= WATER_LEVEL + 1 ? "sand" : "grass") : y >= height - 2 ? "dirt" : "stone";
        setBlock(x, y, z, block);
      }

      if (height < WATER_LEVEL) {
        for (let y = height + 1; y <= WATER_LEVEL; y += 1) {
          setBlock(x, y, z, "water");
        }
      }
    }
  }

  for (let x = -WORLD_RADIUS + 3; x <= WORLD_RADIUS - 3; x += 1) {
    for (let z = -WORLD_RADIUS + 3; z <= WORLD_RADIUS - 3; z += 1) {
      const height = terrainHeight(x, z);
      if (height > WATER_LEVEL + 1 && pseudoRandom(x * 29.7 + z * 63.3) > 0.982) {
        createTree(x, height, z);
      }
    }
  }

  resetPlayer();
}

function highestSolidY(x: number, z: number): number {
  for (let y = MAX_Y; y >= MIN_Y; y -= 1) {
    const block = getBlock(x, y, z);
    if (block && blockDefinitions[block].solid) {
      return y;
    }
  }

  return 0;
}

function resetPlayer(): void {
  player.x = 0;
  player.z = 0;
  player.y = highestSolidY(0, 0) + 2;
  yaw = Math.PI * 1.5;
  pitch = -0.1;
}

function canStandAt(x: number, z: number): boolean {
  const groundY = highestSolidY(Math.round(x), Math.round(z));
  return !getBlock(Math.round(x), groundY + 1, Math.round(z)) && !getBlock(Math.round(x), groundY + 2, Math.round(z));
}

function movePlayer(forwardAmount: number, strafeAmount: number): void {
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const nextX = player.x + forwardX * forwardAmount + rightX * strafeAmount;
  const nextZ = player.z + forwardZ * forwardAmount + rightZ * strafeAmount;

  if (!canStandAt(nextX, nextZ)) {
    return;
  }

  player.x = Math.max(-WORLD_RADIUS + 1, Math.min(WORLD_RADIUS - 1, nextX));
  player.z = Math.max(-WORLD_RADIUS + 1, Math.min(WORLD_RADIUS - 1, nextZ));
  player.y = highestSolidY(Math.round(player.x), Math.round(player.z)) + 2;
}

function traceTarget(): Target | undefined {
  let previousX = Math.round(player.x);
  let previousY = Math.round(player.y);
  let previousZ = Math.round(player.z);

  const direction = directionFromAngles(yaw, pitch);
  for (let distance = 0.4; distance <= REACH; distance += 0.2) {
    const x = Math.round(player.x + direction.x * distance);
    const y = Math.round(player.y + direction.y * distance);
    const z = Math.round(player.z + direction.z * distance);
    const block = getBlock(x, y, z);

    if (block) {
      return { x, y, z, previousX, previousY, previousZ };
    }

    previousX = x;
    previousY = y;
    previousZ = z;
  }

  return undefined;
}

function directionFromAngles(rayYaw: number, rayPitch: number): { x: number; y: number; z: number } {
  const horizontal = Math.cos(rayPitch);
  return {
    x: -Math.sin(rayYaw) * horizontal,
    y: Math.sin(rayPitch),
    z: -Math.cos(rayYaw) * horizontal,
  };
}

function traceRay(rayYaw: number, rayPitch: number): { block?: BlockId; distance: number; y: number } {
  const direction = directionFromAngles(rayYaw, rayPitch);

  for (let distance = 0.5; distance <= MAX_VIEW_DISTANCE; distance += 0.35) {
    const x = Math.round(player.x + direction.x * distance);
    const y = Math.round(player.y + direction.y * distance);
    const z = Math.round(player.z + direction.z * distance);
    const block = getBlock(x, y, z);

    if (block) {
      return { block, distance, y };
    }
  }

  return { distance: MAX_VIEW_DISTANCE, y: player.y };
}

function shadeGlyph(block: BlockId, distance: number, hitY: number): string {
  const definition = blockDefinitions[block];
  const fog = distance / MAX_VIEW_DISTANCE;
  const light = Math.max(0, Math.min(1, (hitY - MIN_Y) / (MAX_Y - MIN_Y)));
  let glyph = definition.glyph;

  if (fog > 0.78) {
    glyph = ".";
  } else if (fog > 0.56) {
    glyph = block === "water" ? "~" : ":";
  } else if (light < 0.2) {
    glyph = block === "water" ? "~" : "+";
  }

  return `${definition.color}${glyph}${ansi.reset}`;
}

function renderSky(row: number): string {
  if (row < VIEW_HEIGHT * 0.35) {
    return "\x1b[38;5;117m.";
  }

  return "\x1b[38;5;153m-";
}

function renderFrame(): string {
  const lines: string[] = [];
  const target = traceTarget();

  lines.push(`${ansi.home}${ansi.bold}Voxel Sandbox Terminal${ansi.reset}  ${ansi.dim}Q quit | B break | P place | R regen${ansi.reset}`);
  lines.push(
    `pos ${Math.round(player.x)},${Math.round(player.y)},${Math.round(player.z)}  blocks ${blocks.size}  selected ${blockDefinitions[palette[selectedBlockIndex]].label}`,
  );

  for (let row = 0; row < VIEW_HEIGHT; row += 1) {
    let line = "";
    const vertical = (row / (VIEW_HEIGHT - 1) - 0.5) * 1.2;

    for (let column = 0; column < VIEW_WIDTH; column += 1) {
      const horizontal = (column / (VIEW_WIDTH - 1) - 0.5) * FOV;
      const rayPitch = Math.max(-1.2, Math.min(1.2, pitch - vertical));
      const hit = traceRay(yaw + horizontal, rayPitch);

      if (row === Math.floor(VIEW_HEIGHT / 2) && column === Math.floor(VIEW_WIDTH / 2)) {
        line += `${ansi.inverse}+${ansi.reset}`;
      } else if (hit.block) {
        line += shadeGlyph(hit.block, hit.distance, hit.y);
      } else {
        line += renderSky(row);
      }
    }

    lines.push(`${line}${ansi.reset}`);
  }

  lines.push(renderInventory());
  lines.push(
    target
      ? `target ${blockDefinitions[getBlock(target.x, target.y, target.z) ?? "stone"].label} at ${target.x},${target.y},${target.z}`
      : "target none",
  );

  return lines.join("\n");
}

function renderInventory(): string {
  return palette
    .map((block, index) => {
      const definition = blockDefinitions[block];
      const label = `${index + 1}:${definition.glyph}`;
      return index === selectedBlockIndex
        ? `${ansi.inverse}${definition.color}${label}${ansi.reset}`
        : `${definition.color}${label}${ansi.reset}`;
    })
    .join(" ");
}

function draw(): void {
  process.stdout.write(renderFrame());
}

function handleInput(buffer: Buffer): void {
  const input = buffer.toString("utf8");

  if (input === "\u0003" || input.toLowerCase() === "q") {
    stopTerminalMode();
    return;
  }

  if (input === "\x1b[D") {
    yaw += 0.14;
  } else if (input === "\x1b[C") {
    yaw -= 0.14;
  } else if (input === "\x1b[A") {
    pitch = Math.min(0.8, pitch + 0.08);
  } else if (input === "\x1b[B") {
    pitch = Math.max(-0.8, pitch - 0.08);
  } else if (input.toLowerCase() === "w") {
    movePlayer(0.55, 0);
  } else if (input.toLowerCase() === "s") {
    movePlayer(-0.55, 0);
  } else if (input.toLowerCase() === "a") {
    movePlayer(0, -0.55);
  } else if (input.toLowerCase() === "d") {
    movePlayer(0, 0.55);
  } else if (input.toLowerCase() === "b") {
    const target = traceTarget();
    if (target) {
      removeBlock(target.x, target.y, target.z);
    }
  } else if (input.toLowerCase() === "p") {
    const target = traceTarget();
    if (target && !getBlock(target.previousX, target.previousY, target.previousZ)) {
      setBlock(target.previousX, target.previousY, target.previousZ, palette[selectedBlockIndex]);
    }
  } else if (input.toLowerCase() === "r") {
    generateWorld();
  } else if (/^[1-7]$/.test(input)) {
    selectedBlockIndex = Number(input) - 1;
  }

  draw();
}

function stopTerminalMode(): void {
  if (!running) {
    return;
  }

  running = false;
  process.stdin.off("data", handleInput);
  process.stdin.pause();

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  process.stdout.write(`${ansi.reset}${ansi.showCursor}\n`);
}

export async function startTerminalMode(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Terminal mode needs an interactive TTY.");
  }

  generateWorld();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", handleInput);
  process.stdout.write(`${ansi.clear}${ansi.hideCursor}`);
  draw();

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (!running) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
}
