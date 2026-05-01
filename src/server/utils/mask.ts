export function maskSecret(value: string | undefined | null): string {
  if (!value) return '<none>';
  if (value.length <= 12) return `${value.slice(0, 3)}…`;
  return `${value.slice(0, 7)}…${value.slice(-6)}`;
}
