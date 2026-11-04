// When to reload a web-chat connector's page after it broke. Pure, so it is unit-tested.

/** How long a problem may last before the page is reloaded, and the waits between reloads. */
export const RECOVERY = { graceMs: Number(process.env.AGENTSTUDIO_WEBCHAT_GRACE_MS || 15_000), backoffMs: [15_000, 30_000, 60_000, 120_000, 300_000], maxTickErrors: 5 };

/** Decides whether to reload the page now. */
export function recoveryStep(
  s: { problemSince: number | null; tickErrors: number; broken: string | null; attempts: number; lastAttemptAt: number },
  now: number,
): "ok" | "wait" | "reload" {
  const unhealthy = s.broken !== null || s.tickErrors >= RECOVERY.maxTickErrors || (s.problemSince !== null && now - s.problemSince >= RECOVERY.graceMs);
  if (!unhealthy) return s.problemSince !== null || s.tickErrors > 0 ? "wait" : "ok";
  if (s.attempts === 0) return "reload";
  const wait = RECOVERY.backoffMs[Math.min(s.attempts - 1, RECOVERY.backoffMs.length - 1)]!;
  return now - s.lastAttemptAt >= wait ? "reload" : "wait";
}
