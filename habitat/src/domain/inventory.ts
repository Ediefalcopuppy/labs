export type Inventory = Record<string, number>;

export function canSpendInventory(inventory: Inventory, required: Inventory): boolean {
  return Object.entries(required).every(([resourceId, amount]) => (inventory[resourceId] ?? 0) >= amount);
}

export function spendInventoryMaterials(inventory: Inventory, required: Inventory): Inventory {
  const nextInventory = { ...inventory };

  for (const [resourceId, amount] of Object.entries(required)) {
    nextInventory[resourceId] = Math.max(0, (nextInventory[resourceId] ?? 0) - amount);
  }

  return nextInventory;
}
