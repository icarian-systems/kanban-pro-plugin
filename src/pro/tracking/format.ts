/**
 * Human-readable duration formatter.
 *
 * Rules:
 *   - < 1s          → "0s"
 *   - < 1 min       → "Ns"
 *   - < 1 hour      → "Nm" (or "Nm Xs" only if < 5 min for granularity)
 *   - < 1 day       → "Nh Mm"
 *   - >= 1 day      → "Nd Hh"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (totalMin < 5) {
    return remSec > 0 ? `${totalMin}m ${remSec}s` : `${totalMin}m`;
  }
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (totalHr < 24) {
    return remMin > 0 ? `${totalHr}h ${remMin}m` : `${totalHr}h`;
  }
  const totalDay = Math.floor(totalHr / 24);
  const remHr = totalHr % 24;
  return remHr > 0 ? `${totalDay}d ${remHr}h` : `${totalDay}d`;
}
