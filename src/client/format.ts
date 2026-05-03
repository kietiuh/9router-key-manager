export const fmt = (n?: number | null) => n == null ? '—' : n.toLocaleString();
export const pct = (n?: number | null) => n == null ? '—' : `${n.toFixed(1)}%`;

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
