export const fmt = (n?: number | null) => n == null ? '—' : n.toLocaleString();
export const pct = (n?: number | null) => n == null ? '—' : `${n.toFixed(1)}%`;
export const bytes = (n?: number | null) => {
  if (n == null) return '—';
  if (n >= 1024 * 1024) return `${Number((n / 1024 / 1024).toFixed(1))} MB`;
  if (n < 1024) return `${n} B`;
  return `${Number((n / 1024).toFixed(1))} KB`;
};

export function vnDateTime(utc?: string | null) {
  if (!utc) return '—';
  return new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(utc));
}

export function toVnInput(utc?: string | null) {
  if (!utc) return '';
  return new Date(new Date(utc).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

export function fromVnInput(v: FormDataEntryValue | null) {
  if (!v) return null;
  return new Date(new Date(`${v}:00.000Z`).getTime() - 7 * 60 * 60 * 1000).toISOString();
}

export function publicDateTime(utc?: string | null) {
  if (!utc) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false }).formatToParts(new Date(utc));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('hour')}:${get('minute')} ${get('day')}/${get('month')}/${get('year')}`;
}
