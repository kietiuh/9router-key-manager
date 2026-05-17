import type { ImageUsageSummary } from '../shared/types';
import { bytes as fmtBytes, fmt, vnDateTime } from './format';

export function ImageUsagePanel({ usage }: { usage: ImageUsageSummary | null }) {
  const recent = usage?.events.slice(0, 8) ?? [];
  return <section className="attention imageUsagePanel"><h2>Image Studio usage</h2><div className="imageUsageStats"><label>Images today<b>{fmt(usage?.todayImages)}</b></label><label>Total images<b>{fmt(usage?.totalImages)}</b></label><label>Success<b>{fmt(usage?.success)}</b></label><label>Errors<b>{fmt(usage?.errors)}</b></label><label>Bytes<b>{fmtBytes(usage?.bytes)}</b></label></div><div className="imageEvents">{recent.length ? recent.map(e => <div className={`imageEvent ${e.status}`} key={e.id}><div><b>{e.model}</b><span>{e.size ?? '—'} · {e.kind}</span></div><p>{e.prompt_preview || e.error || '—'}</p><em>{vnDateTime(e.created_at)} · {fmt(e.image_count)} img · {fmtBytes(e.bytes)}</em></div>) : <p>No image jobs yet.</p>}</div></section>;
}
