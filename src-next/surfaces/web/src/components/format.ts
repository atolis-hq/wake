export function fmtCost(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

export function fmtCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.max(1, Math.floor(ms / 1_000));
  if (totalSeconds < 10) return `${totalSeconds}s`;
  if (totalSeconds < 60) return `${Math.floor(totalSeconds / 10) * 10}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h${totalMinutes % 60}m`;
  return `${Math.floor(totalHours / 24)}d`;
}
