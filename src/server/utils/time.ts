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

export function toVietnamLocalInput(utcIso?: string | null): string {
  if (!utcIso) return '';
  const d = new Date(new Date(utcIso).getTime() + VN_OFFSET_MS);
  return d.toISOString().slice(0, 16);
}

export function fromVietnamLocalInput(value?: string | null): string | null {
  if (!value) return null;
  return new Date(new Date(`${value}:00.000Z`).getTime() - VN_OFFSET_MS).toISOString();
}
