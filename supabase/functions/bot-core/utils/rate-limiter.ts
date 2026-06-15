const rateLimitMap = new Map<number, number[]>();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_CLEANUP_INTERVAL = 300000;

let lastCleanup = Date.now();

export function cleanupRateLimit(): void {
  const now = Date.now();
  if (now - lastCleanup < RATE_LIMIT_CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [userId, timestamps] of rateLimitMap.entries()) {
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW);
    if (recent.length === 0) {
      rateLimitMap.delete(userId);
    } else {
      rateLimitMap.set(userId, recent);
    }
  }
}

export function isRateLimited(userId: number): boolean {
  cleanupRateLimit();
  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) || [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW);
  if (recent.length >= RATE_LIMIT_MAX) return true;
  recent.push(now);
  rateLimitMap.set(userId, recent);
  return false;
}

const CALLBACK_DATA_MAX_LENGTH = 60;

export function truncateCallbackData(data: string): string {
  if (data.length <= CALLBACK_DATA_MAX_LENGTH) return data;
  return data.substring(0, CALLBACK_DATA_MAX_LENGTH);
}
