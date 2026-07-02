import * as THREE from "three";
import "./styles.css";

type BlockId = "grass" | "dirt" | "stone" | "sand" | "wood" | "leaves" | "water";

type BlockPosition = {
  x: number;
  y: number;
  z: number;
};

type SpawnPoint = {
  position: THREE.Vector3;
  yaw: number;
};

type BlockDefinition = {
  label: string;
  color: number;
  solid: boolean;
  texture: THREE.CanvasTexture;
  transparent?: boolean;
  opacity?: number;
};

declare global {
  interface Window {
    __voxelDebug?: {
      sampleCanvas: () => {
        width: number;
        height: number;
        samples: number;
        uniqueSampledColors: number;
        nonBlack: number;
        ok: boolean;
      };
      stats: () => {
        totalBlocks: number;
        visibleBlocks: number;
        selectedBlock: BlockId;
        player: {
          x: number;
          y: number;
          z: number;
        };
      };
    };
  }
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing game shell element: ${selector}`);
  }

  return element;
}

const app = requireElement<HTMLDivElement>("#app");
const menu = requireElement<HTMLElement>("#menu");
const enterWorldButton = requireElement<HTMLButtonElement>("#enter-world");
const inventory = requireElement<HTMLDivElement>("#inventory");
const coords = requireElement<HTMLSpanElement>("#coords");
const blockCount = requireElement<HTMLSpanElement>("#block-count");

const WORLD_RADIUS = 22;
const MIN_Y = -4;
const MAX_Y = 26;
const WATER_LEVEL = 1;
const PLAYER_HEIGHT = 1.72;
const PLAYER_EYE_HEIGHT = 1.58;
const PLAYER_RADIUS = 0.34;
const GRAVITY = 23;
const JUMP_SPEED = 7.6;
const WALK_SPEED = 5.2;
const SPRINT_SPEED = 7.4;
const REACH = 7;

const neighborOffsets = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

function toHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function shade(color: number, amount: number): number {
  const r = Math.max(0, Math.min(255, ((color >> 16) & 255) + amount));
  const g = Math.max(0, Math.min(255, ((color >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (color & 255) + amount));
  return (r << 16) | (g << 8) | b;
}

function pseudoRandom(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function createBlockTexture(base: number, flecks: number[], bands: number[] = []): THREE.CanvasTexture {
  const size = 32;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Could not create block texture.");
  }

  canvas.width = size;
  canvas.height = size;
  context.imageSmoothingEnabled = false;
  context.fillStyle = toHex(base);
  context.fillRect(0, 0, size, size);

  bands.forEach((band, index) => {
    context.fillStyle = toHex(band);
    const y = index * 5 + 2;
    context.fillRect(0, y, size, 2);
  });

  for (let index = 0; index < 140; index += 1) {
    const fleck = flecks[Math.floor(pseudoRandom(index + base) * flecks.length)] ?? base;
    const x = Math.floor(pseudoRandom(index * 3 + base) * size);
    const y = Math.floor(pseudoRandom(index * 7 + base) * size);
    const width = pseudoRandom(index * 11 + base) > 0.7 ? 2 : 1;

    context.fillStyle = toHex(fleck);
    context.fillRect(x, y, width, width);
  }

  context.fillStyle = toHex(shade(base, -34));
  context.globalAlpha = 0.28;
  context.fillRect(0, size - 3, size, 3);
  context.fillRect(size - 3, 0, 3, size);
  context.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;

  return texture;
}

const blockDefinitions: Record<BlockId, BlockDefinition> = {
  grass: {
    label: "Grass",
    color: 0x4f9a43,
    solid: true,
    texture: createBlockTexture(0x4f9a43, [0x3f7f36, 0x70b958, 0x2f682b], [0x78c863]),
  },
  dirt: {
    label: "Dirt",
    color: 0x76523a,
    solid: true,
    texture: createBlockTexture(0x76523a, [0x5c3e2b, 0x8a6042, 0xa0714a]),
  },
  stone: {
    label: "Stone",
    color: 0x7d858d,
    solid: true,
    texture: createBlockTexture(0x7d858d, [0x69727a, 0xa0a8ae, 0x565e66]),
  },
  sand: {
    label: "Sand",
    color: 0xd6c071,
    solid: true,
    texture: createBlockTexture(0xd6c071, [0xbfaa62, 0xf0dc8a, 0xa99454]),
  },
  wood: {
    label: "Wood",
    color: 0x8a5a32,
    solid: true,
    texture: createBlockTexture(0x8a5a32, [0x6f4524, 0xab7141, 0x4e2f1b], [0x5f371d, 0xa66d3e]),
  },
  leaves: {
    label: "Leaves",
    color: 0x2f7d4a,
    solid: true,
    transparent: true,
    opacity: 0.92,
    texture: createBlockTexture(0x2f7d4a, [0x245f39, 0x4ca56a, 0x1e4e31]),
  },
  water: {
    label: "Water",
    color: 0x2e8ed6,
    solid: false,
    transparent: true,
    opacity: 0.58,
    texture: createBlockTexture(0x2e8ed6, [0x48a7ef, 0x1c6fb3, 0x7bc9ff], [0x74c4f5]),
  },
};

const blockPalette: BlockId[] = ["grass", "dirt", "stone", "sand", "wood", "leaves", "water"];
const blocks = new Map<string, BlockId>();
const instanceMaps = new Map<string, BlockPosition[]>();
const slotButtons = new Map<BlockId, HTMLButtonElement>();

let selectedBlockIndex = 0;
let visibleBlockCount = 0;
let debugFrameCounter = 0;
let yaw = Math.PI;
let pitch = -0.25;
let isPointerLocked = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87bce6);
scene.fog = new THREE.Fog(0x87bce6, 45, 82);

const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 140);
camera.rotation.order = "YXZ";

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x87bce6);
app.append(renderer.domElement);

const worldGroup = new THREE.Group();
scene.add(worldGroup);

const ambientLight = new THREE.HemisphereLight(0xcde7ff, 0x6d624f, 1.6);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xfff1c2, 2.15);
sunLight.position.set(-22, 34, 18);
scene.add(sunLight);

const blockGeometry = new THREE.BoxGeometry(1, 1, 1);
const materials = Object.fromEntries(
  blockPalette.map((blockId) => {
    const definition = blockDefinitions[blockId];
    const material = new THREE.MeshLambertMaterial({
      map: definition.texture,
      transparent: definition.transparent ?? false,
      opacity: definition.opacity ?? 1,
      depthWrite: !definition.transparent,
    });

    return [blockId, material];
  }),
) as Record<BlockId, THREE.MeshLambertMaterial>;

const targetCursor = new THREE.Mesh(
  new THREE.BoxGeometry(1.04, 1.04, 1.04),
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.82,
    wireframe: true,
  }),
);
targetCursor.visible = false;
scene.add(targetCursor);

const raycaster = new THREE.Raycaster();
raycaster.far = REACH;
const centerPointer = new THREE.Vector2(0, 0);
const dummy = new THREE.Object3D();

const player = {
  position: new THREE.Vector3(0, 9, 0),
  velocity: new THREE.Vector3(0, 0, 0),
  onGround: false,
};

const keys = new Set<string>();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const desiredVelocity = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

function blockKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function parseBlockKey(key: string): BlockPosition {
  const [x, y, z] = key.split(",").map(Number);
  return { x, y, z };
}

function getBlock(x: number, y: number, z: number): BlockId | undefined {
  return blocks.get(blockKey(x, y, z));
}

function setBlock(x: number, y: number, z: number, blockId: BlockId): void {
  blocks.set(blockKey(x, y, z), blockId);
}

function removeBlockAt(position: BlockPosition): void {
  blocks.delete(blockKey(position.x, position.y, position.z));
}

function terrainHeight(x: number, z: number): number {
  const rolling = Math.sin(x * 0.25) * 1.4 + Math.cos(z * 0.21) * 1.2;
  const hills = Math.sin((x + z) * 0.12) * 1.8 + Math.cos((x - z) * 0.17) * 1.35;
  const detail = pseudoRandom(x * 15.31 + z * 91.7) * 1.7;
  return Math.floor(2 + rolling + hills + detail);
}

function treeChance(x: number, z: number): number {
  return pseudoRandom(x * 29.7 + z * 63.3);
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
        const blockId: BlockId =
          y === height ? (height <= WATER_LEVEL + 1 ? "sand" : "grass") : y >= height - 2 ? "dirt" : "stone";
        setBlock(x, y, z, blockId);
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
      if (height > WATER_LEVEL + 1 && treeChance(x, z) > 0.982) {
        createTree(x, height, z);
      }
    }
  }

  rebuildWorldMeshes();
  resetPlayer();
  updateHud();
}

function shouldRenderBlock(position: BlockPosition, blockId: BlockId): boolean {
  const definition = blockDefinitions[blockId];

  return neighborOffsets.some(([dx, dy, dz]) => {
    const neighbor = getBlock(position.x + dx, position.y + dy, position.z + dz);

    if (!neighbor) {
      return true;
    }

    if (blockId === "water") {
      return neighbor !== "water";
    }

    return !blockDefinitions[neighbor].solid || blockDefinitions[neighbor].transparent;
  });
}

function rebuildWorldMeshes(): void {
  worldGroup.clear();
  instanceMaps.clear();

  const byType = new Map<BlockId, BlockPosition[]>();
  blockPalette.forEach((blockId) => byType.set(blockId, []));

  blocks.forEach((blockId, key) => {
    const position = parseBlockKey(key);

    if (shouldRenderBlock(position, blockId)) {
      byType.get(blockId)?.push(position);
    }
  });

  visibleBlockCount = 0;

  blockPalette.forEach((blockId) => {
    const positions = byType.get(blockId) ?? [];
    if (positions.length === 0) {
      return;
    }

    const mesh = new THREE.InstancedMesh(blockGeometry, materials[blockId], positions.length);
    mesh.frustumCulled = false;
    mesh.renderOrder = blockId === "water" ? 2 : 1;
    mesh.userData.blockId = blockId;

    positions.forEach((position, index) => {
      dummy.position.set(position.x, position.y, position.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
    instanceMaps.set(mesh.uuid, positions);
    worldGroup.add(mesh);
    visibleBlockCount += positions.length;
  });
}

function highestSolidY(x: number, z: number): number {
  for (let y = MAX_Y; y >= MIN_Y; y -= 1) {
    const blockId = getBlock(x, y, z);
    if (blockId && blockDefinitions[blockId].solid) {
      return y;
    }
  }

  return 0;
}

function viewScore(position: THREE.Vector3, directionYaw: number): number {
  const directionX = -Math.sin(directionYaw);
  const directionZ = -Math.cos(directionYaw);
  let score = 0;

  for (let step = 1; step <= 7; step += 1) {
    const x = Math.round(position.x + directionX * step);
    const z = Math.round(position.z + directionZ * step);

    for (let y = Math.floor(position.y + 0.4); y <= Math.floor(position.y + PLAYER_EYE_HEIGHT); y += 1) {
      const blockId = getBlock(x, y, z);
      if (blockId && blockDefinitions[blockId].solid) {
        return score;
      }
    }

    score += 1;
  }

  return score;
}

function findSpawnPoint(): SpawnPoint {
  const yawOptions = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
  let bestSpawn: SpawnPoint | undefined;
  let bestScore = -1;

  for (let radius = 0; radius <= 10; radius += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      for (let z = -radius; z <= radius; z += 1) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== radius) {
          continue;
        }

        if (terrainHeight(x, z) <= WATER_LEVEL) {
          continue;
        }

        const candidate = new THREE.Vector3(x, highestSolidY(x, z) + 0.62, z);
        if (!positionCollides(candidate)) {
          for (const candidateYaw of yawOptions) {
            const score = viewScore(candidate, candidateYaw);

            if (score > bestScore) {
              bestSpawn = { position: candidate.clone(), yaw: candidateYaw };
              bestScore = score;
            }

            if (score >= 6) {
              return { position: candidate, yaw: candidateYaw };
            }
          }
        }
      }
    }
  }

  return bestSpawn ?? { position: new THREE.Vector3(0, highestSolidY(0, 0) + 0.62, 0), yaw: Math.PI };
}

function resetPlayer(): void {
  const spawn = findSpawnPoint();
  player.position.copy(spawn.position);
  player.velocity.set(0, 0, 0);
  player.onGround = false;
  yaw = spawn.yaw;
  pitch = -0.18;
  updateCamera();
}

function rangesOverlap(minA: number, maxA: number, minB: number, maxB: number): boolean {
  return minA < maxB && maxA > minB;
}

function positionCollides(position: THREE.Vector3): boolean {
  const minX = position.x - PLAYER_RADIUS;
  const maxX = position.x + PLAYER_RADIUS;
  const minY = position.y;
  const maxY = position.y + PLAYER_HEIGHT;
  const minZ = position.z - PLAYER_RADIUS;
  const maxZ = position.z + PLAYER_RADIUS;

  for (let x = Math.floor(minX - 0.5); x <= Math.ceil(maxX + 0.5); x += 1) {
    for (let y = Math.floor(minY - 0.5); y <= Math.ceil(maxY + 0.5); y += 1) {
      for (let z = Math.floor(minZ - 0.5); z <= Math.ceil(maxZ + 0.5); z += 1) {
        const blockId = getBlock(x, y, z);

        if (!blockId || !blockDefinitions[blockId].solid) {
          continue;
        }

        if (
          rangesOverlap(minX, maxX, x - 0.5, x + 0.5) &&
          rangesOverlap(minY, maxY, y - 0.5, y + 0.5) &&
          rangesOverlap(minZ, maxZ, z - 0.5, z + 0.5)
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

function tryMove(axis: "x" | "y" | "z", amount: number): void {
  if (amount === 0) {
    return;
  }

  const nextPosition = player.position.clone();
  nextPosition[axis] += amount;

  if (!positionCollides(nextPosition)) {
    player.position.copy(nextPosition);
    return;
  }

  if (axis === "y" && amount < 0) {
    player.onGround = true;
  }

  player.velocity[axis] = 0;
}

function updateCamera(): void {
  camera.rotation.set(pitch, yaw, 0);
  camera.position.set(player.position.x, player.position.y + PLAYER_EYE_HEIGHT, player.position.z);
}

function updatePlayer(deltaSeconds: number): void {
  const inputZ = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
  const inputX = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
  const speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? SPRINT_SPEED : WALK_SPEED;

  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();
  right.crossVectors(forward, up).normalize();

  desiredVelocity.set(0, 0, 0);
  desiredVelocity.addScaledVector(forward, inputZ);
  desiredVelocity.addScaledVector(right, inputX);

  if (desiredVelocity.lengthSq() > 0) {
    desiredVelocity.normalize().multiplyScalar(speed);
  }

  const blend = 1 - Math.exp(-14 * deltaSeconds);
  player.velocity.x += (desiredVelocity.x - player.velocity.x) * blend;
  player.velocity.z += (desiredVelocity.z - player.velocity.z) * blend;

  if (keys.has("Space") && player.onGround) {
    player.velocity.y = JUMP_SPEED;
    player.onGround = false;
  }

  player.velocity.y -= GRAVITY * deltaSeconds;
  player.onGround = false;

  tryMove("x", player.velocity.x * deltaSeconds);
  tryMove("z", player.velocity.z * deltaSeconds);
  tryMove("y", player.velocity.y * deltaSeconds);

  if (player.position.y < MIN_Y - 14) {
    resetPlayer();
  }

  updateCamera();
  updateHud();
}

function currentTarget(): { block: BlockPosition; place: BlockPosition } | undefined {
  raycaster.setFromCamera(centerPointer, camera);
  const hits = raycaster.intersectObjects(worldGroup.children, false);
  const hit = hits.find((candidate) => candidate.instanceId !== undefined);

  if (!hit || hit.instanceId === undefined || !hit.face) {
    targetCursor.visible = false;
    return undefined;
  }

  const positions = instanceMaps.get(hit.object.uuid);
  const block = positions?.[hit.instanceId];

  if (!block) {
    targetCursor.visible = false;
    return undefined;
  }

  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  const place = {
    x: block.x + Math.round(normal.x),
    y: block.y + Math.round(normal.y),
    z: block.z + Math.round(normal.z),
  };

  targetCursor.position.set(block.x, block.y, block.z);
  targetCursor.visible = true;

  return { block, place };
}

function breakTargetBlock(): void {
  const target = currentTarget();
  if (!target) {
    return;
  }

  removeBlockAt(target.block);
  rebuildWorldMeshes();
  updateHud();
}

function placeSelectedBlock(): void {
  const target = currentTarget();
  if (!target || target.place.y < MIN_Y || target.place.y > MAX_Y) {
    return;
  }

  if (getBlock(target.place.x, target.place.y, target.place.z)) {
    return;
  }

  setBlock(target.place.x, target.place.y, target.place.z, blockPalette[selectedBlockIndex]);

  if (positionCollides(player.position)) {
    removeBlockAt(target.place);
    return;
  }

  rebuildWorldMeshes();
  updateHud();
}

function selectBlock(index: number): void {
  selectedBlockIndex = (index + blockPalette.length) % blockPalette.length;

  slotButtons.forEach((button, blockId) => {
    button.classList.toggle("is-selected", blockId === blockPalette[selectedBlockIndex]);
  });
}

function createInventory(): void {
  blockPalette.forEach((blockId, index) => {
    const definition = blockDefinitions[blockId];
    const button = document.createElement("button");
    const swatch = document.createElement("span");
    const key = document.createElement("span");

    button.type = "button";
    button.className = "slot";
    button.title = definition.label;
    button.ariaLabel = definition.label;
    button.style.setProperty("--swatch", toHex(definition.color));

    swatch.className = "slot-swatch";
    key.className = "slot-key";
    key.textContent = String(index + 1);

    button.append(swatch, key);
    button.addEventListener("click", () => selectBlock(index));
    inventory.append(button);
    slotButtons.set(blockId, button);
  });

  selectBlock(0);
}

function updateHud(): void {
  coords.textContent = `${Math.round(player.position.x)} ${Math.round(player.position.y)} ${Math.round(player.position.z)}`;
  blockCount.textContent = `${visibleBlockCount}/${blocks.size}`;
}

function sampleCanvasPixels(): {
  width: number;
  height: number;
  samples: number;
  uniqueSampledColors: number;
  nonBlack: number;
  ok: boolean;
} {
  const gl = renderer.getContext();
  const canvas = renderer.domElement;
  const pixel = new Uint8Array(4);
  const colors = new Set<string>();
  let samples = 0;
  let nonBlack = 0;

  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 12; column += 1) {
      const x = Math.floor((column + 0.5) * canvas.width / 12);
      const y = Math.floor((row + 0.5) * canvas.height / 9);
      gl.readPixels(x, canvas.height - y - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      colors.add(`${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3]}`);
      samples += 1;

      if (pixel[0] + pixel[1] + pixel[2] > 20) {
        nonBlack += 1;
      }
    }
  }

  return {
    width: canvas.width,
    height: canvas.height,
    samples,
    uniqueSampledColors: colors.size,
    nonBlack,
    ok: canvas.width > 0 && canvas.height > 0 && colors.size > 16 && nonBlack > samples * 0.95,
  };
}

function installDebugHooks(): void {
  window.__voxelDebug = {
    sampleCanvas: sampleCanvasPixels,
    stats: () => ({
      totalBlocks: blocks.size,
      visibleBlocks: visibleBlockCount,
      selectedBlock: blockPalette[selectedBlockIndex],
      player: {
        x: Number(player.position.x.toFixed(2)),
        y: Number(player.position.y.toFixed(2)),
        z: Number(player.position.z.toFixed(2)),
      },
    }),
  };
}

function publishDebugData(): void {
  const debug = window.__voxelDebug;

  if (!debug) {
    return;
  }

  document.documentElement.dataset.voxelDebug = JSON.stringify({
    sample: debug.sampleCanvas(),
    stats: debug.stats(),
  });
}

function requestPointerLock(): void {
  renderer.domElement.requestPointerLock();
}

enterWorldButton.addEventListener("click", requestPointerLock);
renderer.domElement.addEventListener("click", () => {
  if (!isPointerLocked) {
    requestPointerLock();
  }
});

document.addEventListener("pointerlockchange", () => {
  isPointerLocked = document.pointerLockElement === renderer.domElement;
  menu.classList.toggle("is-hidden", isPointerLocked);
});

document.addEventListener("mousemove", (event) => {
  if (!isPointerLocked) {
    return;
  }

  yaw -= event.movementX * 0.0024;
  pitch -= event.movementY * 0.0024;
  pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
});

document.addEventListener("mousedown", (event) => {
  if (!isPointerLocked) {
    return;
  }

  event.preventDefault();

  if (event.button === 0) {
    breakTargetBlock();
  } else if (event.button === 2) {
    placeSelectedBlock();
  }
});

document.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("keydown", (event) => {
  if (event.code === "KeyR") {
    generateWorld();
    return;
  }

  if (event.code.startsWith("Digit")) {
    const digit = Number(event.code.replace("Digit", ""));
    if (digit >= 1 && digit <= blockPalette.length) {
      selectBlock(digit - 1);
    }
  }

  if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"].includes(event.code)) {
    event.preventDefault();
    keys.add(event.code);
  }
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

window.addEventListener("wheel", (event) => {
  if (!isPointerLocked) {
    return;
  }

  event.preventDefault();
  selectBlock(selectedBlockIndex + (event.deltaY > 0 ? 1 : -1));
});

window.addEventListener("blur", () => {
  keys.clear();
});

window.addEventListener("resize", () => {
  const width = window.innerWidth;
  const height = window.innerHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
});

let previousTime = performance.now();

function animate(time: number): void {
  const deltaSeconds = Math.min(0.05, (time - previousTime) / 1000);
  previousTime = time;

  updatePlayer(deltaSeconds);
  currentTarget();
  renderer.render(scene, camera);
  debugFrameCounter += 1;

  if (debugFrameCounter % 30 === 0) {
    publishDebugData();
  }

  requestAnimationFrame(animate);
}

createInventory();
generateWorld();
installDebugHooks();
publishDebugData();
requestAnimationFrame(animate);
