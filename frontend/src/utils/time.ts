export function formatFuzzyTime(timestamp: number | null): string {
  if (!timestamp) return 'Never';

  const now = Date.now();
  const diffSeconds = Math.floor((now - timestamp) / 1000);

  if (diffSeconds < 60) {
    return `${diffSeconds} seconds ago`;
  } else if (diffSeconds < 3600) {
    const minutes = Math.floor(diffSeconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  } else if (diffSeconds < 86400) {
    const hours = Math.floor(diffSeconds / 3600);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  } else if (diffSeconds < 2592000) { // 30 days
    const days = Math.floor(diffSeconds / 86400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  } else {
    return new Date(timestamp).toLocaleDateString();
  }
}

export function formatCompactTime(
  timestamp?: number | string | Date | { seconds?: bigint; nanos?: number } | null
): string {
  if (!timestamp) return 'Never';

  let ms = 0;
  if (typeof timestamp === 'number') {
    ms = timestamp;
  } else if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    if (isNaN(parsed)) return 'Invalid Date';
    ms = parsed;
  } else if (timestamp instanceof Date) {
    if (isNaN(timestamp.getTime())) return 'Invalid Date';
    ms = timestamp.getTime();
  } else if (typeof timestamp === 'object' && 'seconds' in timestamp && timestamp.seconds !== undefined) {
    ms = Number(timestamp.seconds) * 1000 + Math.floor((timestamp.nanos || 0) / 1000000);
  }

  if (!ms || isNaN(ms)) return 'Never';

  const diffMs = Math.max(0, Date.now() - ms);
  const diffSecs = Math.floor(diffMs / 1000);

  if (diffSecs < 60) return `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function formatExactDateTime(
  timestamp?: number | string | Date | { seconds?: bigint; nanos?: number } | null
): string | undefined {
  if (!timestamp) return undefined;

  let ms = 0;
  if (typeof timestamp === 'number') {
    ms = timestamp;
  } else if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    if (isNaN(parsed)) return undefined;
    ms = parsed;
  } else if (timestamp instanceof Date) {
    if (isNaN(timestamp.getTime())) return undefined;
    ms = timestamp.getTime();
  } else if (typeof timestamp === 'object' && 'seconds' in timestamp && timestamp.seconds !== undefined) {
    ms = Number(timestamp.seconds) * 1000 + Math.floor((timestamp.nanos || 0) / 1000000);
  }

  if (!ms || isNaN(ms)) return undefined;
  return new Date(ms).toLocaleString();
}