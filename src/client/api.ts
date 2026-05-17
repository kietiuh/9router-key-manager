export function messageFromErrorText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error === 'string') return parsed.error;
    if (typeof parsed?.error?.message === 'string') return parsed.error.message;
    if (typeof parsed?.message === 'string') return parsed.message;
  } catch {
    // Plain text response.
  }
  return text || 'Request failed';
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(url, { ...init, headers, credentials: 'include' });
  if (!res.ok) throw new Error(messageFromErrorText(await res.text()));
  if (res.status === 204) return undefined as T;
  return res.json();
}
