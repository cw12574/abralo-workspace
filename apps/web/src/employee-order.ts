export function reconcileEmployeeOrder(ids: string[], saved: unknown): string[] {
  const available = new Set(ids);
  const preferred = Array.isArray(saved)
    ? saved.filter((id): id is string => typeof id === 'string' && available.has(id))
    : [];
  return [...new Set([...preferred, ...ids])];
}

export function moveEmployee(ids: string[], id: string, destination: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const next = ids.filter((value) => value !== id);
  next.splice(Math.max(0, Math.min(next.length, destination)), 0, id);
  return next;
}

export function closestEmployeeSlot(centres: number[], centre: number): number {
  return centres.reduce(
    (best, value, index) =>
      Math.abs(value - centre) < Math.abs(centres[best] - centre) ? index : best,
    0,
  );
}
