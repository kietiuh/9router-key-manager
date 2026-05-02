const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
export const VN_TZ_LABEL = 'UTC+7';

export function startOfVietnamDayUtc(now = new Date()): string {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const y = vn.getUTCFullYear();
  const m = vn.getUTCMonth();
  const d = vn.getUTCDate();
  return new Date(Date.UTC(y, m, d) - VN_OFFSET_MS).toISOString();
}

export function endOfVietnamDayUtc(now = new Date()): string {
  return new Date(new Date(startOfVietnamDayUtc(now)).getTime() + 24 * 60 * 60 * 1000).toISOString();
}

export function startOfVietnamMonthUtc(now = new Date()): string {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), 1) - VN_OFFSET_MS).toISOString();
}

export function endOfVietnamMonthUtc(now = new Date()): string {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth() + 1, 1) - VN_OFFSET_MS).toISOString();
}

export function resolveWindow(policy: { window_start?: string | null; window_end?: string | null; reset_policy?: string | null }, now = new Date()) {
  const resetPolicy = (policy.reset_policy ?? 'manual') as 'manual' | 'daily' | 'monthly' | 'custom';
  if (resetPolicy === 'daily') return { windowStart: startOfVietnamDayUtc(now), windowEnd: endOfVietnamDayUtc(now), resetPolicy };
  if (resetPolicy === 'monthly') return { windowStart: startOfVietnamMonthUtc(now), windowEnd: endOfVietnamMonthUtc(now), resetPolicy };
  return { windowStart: policy.window_start ?? '1970-01-01T00:00:00.000Z', windowEnd: policy.window_end ?? null, resetPolicy };
}

export function toVietnamLocalInput(utcIso?: string | null): string {
  if (!utcIso) return '';
  const d = new Date(new Date(utcIso).getTime() + VN_OFFSET_MS);
  return d.toISOString().slice(0, 16);
}

export function fromVietnamLocalInput(value?: string | null): string | null {
  if (!value) return null;
  return new Date(new Date(`${value}:00.000Z`).getTime() - VN_OFFSET_MS).toISOString();
}
