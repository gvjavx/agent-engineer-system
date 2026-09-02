// When a provider instance returns a 429, park it for a short cooldown so the
// next buildProviders() sinks it to the back of the fallback chain instead of
// hammering the same exhausted key/model again (and eating the in-loop retry
// delay every turn). Free-tier quotas are mostly per-minute, so the window is
// short; it's a hint, not a hard block — the loop still falls back onto a
// cooled instance if every other option is also down.

const DEFAULT_COOLDOWN_MS = 60_000;
const MIN_COOLDOWN_MS = 5_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

const until = new Map<string, number>();

export function markRateLimited(id: string, retryAfterMs?: number): void {
  const ms = Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, retryAfterMs ?? DEFAULT_COOLDOWN_MS));
  until.set(id, Date.now() + ms);
}

export function cooldownRemainingMs(id: string): number {
  const t = until.get(id);
  if (t === undefined) return 0;
  const left = t - Date.now();
  if (left <= 0) {
    until.delete(id);
    return 0;
  }
  return left;
}

export function isCoolingDown(id: string): boolean {
  return cooldownRemainingMs(id) > 0;
}

// Stable partition: original order preserved, cooled-down instances just moved
// to the back — so [0] is the best currently-available option and an
// order-preserving fallback chain still reaches a cooled one last.
export function deprioritizeCooledDown<T extends { id?: string; name: string }>(providers: T[]): T[] {
  const ready: T[] = [];
  const cooling: T[] = [];
  for (const p of providers) (isCoolingDown(p.id ?? p.name) ? cooling : ready).push(p);
  return [...ready, ...cooling];
}

// For the status dashboard — which instances are parked and for how long.
export function coolingDownNow(): { id: string; secondsLeft: number }[] {
  const out: { id: string; secondsLeft: number }[] = [];
  for (const id of [...until.keys()]) {
    const left = cooldownRemainingMs(id);
    if (left > 0) out.push({ id, secondsLeft: Math.ceil(left / 1000) });
  }
  return out.sort((a, b) => b.secondsLeft - a.secondsLeft);
}

export function clearCooldownsForTests(): void {
  until.clear();
}
