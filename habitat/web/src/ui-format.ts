export type MaterialInput = Record<string, unknown> | null | undefined;

export function isDoomEasterEgg(query: string): boolean {
  return query.trim().toUpperCase() === "DOOM1234";
}

export function notificationSummary(title: string, text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return `${title}: ${lines.slice(0, 2).join(" · ") || "Completed."}`;
}

export function resourceScanPayload(values: { x: string; y: string; sensorStrength: string; radiusTiles: string; useEvaPosition: boolean }): Record<string, number> {
  const payload: Record<string, number> = {
    sensorStrength: Number(values.sensorStrength),
    radiusTiles: Number(values.radiusTiles),
  };
  if (!values.useEvaPosition) {
    payload.x = Number(values.x);
    payload.y = Number(values.y);
  }
  return payload;
}

export type ConstructionProgress = {
  remainingBuildTicks: unknown;
  totalBuildTicks: unknown;
};

export function materialEntries(inputs: MaterialInput): Array<[string, number]> {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return [];

  return Object.entries(inputs)
    .map(([resourceId, value]) => {
      const amount = typeof value === "number" ? value : Number(value);
      return [resourceId, amount] as [string, number];
    })
    .filter(([, amount]) => Number.isFinite(amount) && amount > 0);
}

export function constructionProgress(job: ConstructionProgress): {
  remaining: number;
  total: number;
  completed: number;
  percent: number;
  label: string;
} {
  const total = Math.max(0, Number(job.totalBuildTicks) || 0);
  const remaining = Math.min(total, Math.max(0, Number(job.remainingBuildTicks) || 0));
  const completed = Math.max(0, total - remaining);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 100;
  return {
    remaining,
    total,
    completed,
    percent,
    label: remaining === 0 ? "Complete" : `${remaining.toLocaleString()} ${remaining === 1 ? "tick" : "ticks"} remaining`,
  };
}
