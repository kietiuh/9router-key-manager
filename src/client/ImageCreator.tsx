import { useMemo, useState } from 'react';
import { api } from './api';
import { bytes as fmtBytes } from './format';
import type {
  PublicImageFileResponse as ImageFileResponse,
  PublicImageGenerateResponse as GenerateResponse,
  PublicImageHistoryItem as HistoryItem,
  PublicImageHistoryResponse as HistoryResponse,
  PublicImageJobView as ImageJobStatus,
  PublicImageOptimizeResponse as OptimizeResponse,
} from '../shared/types';

type HistoryPreview = ImageFileResponse & { id: number };

const imageKeyStorage = 'gocinema:imageKey';
const busyOptimize = 'optimize';
const busyGenerate = 'generate';
const samplePrompt = 'A cinematic Vietnamese dragon made of golden light flying above Ha Long Bay at sunrise, ultra detailed, magical atmosphere';
const imageErrorLabels: Record<string, string> = {
  'invalid key': 'Key không hợp lệ hoặc đã bị tắt.',
  'image proxy disabled': 'Tính năng tạo ảnh chưa được bật trên server.',
  'image service not configured': 'Server chưa cấu hình dịch vụ tạo ảnh.',
  'image generation failed': 'Dịch vụ tạo ảnh chưa trả về ảnh hợp lệ.',
  'image upstream error': 'Dịch vụ tạo ảnh đang lỗi hoặc phản hồi quá lâu.',
  'Prompt is empty': 'Prompt đang trống.',
  'Prompt is not allowed': 'Prompt không được phép tạo ảnh.',
};

function friendlyImageError(message: string) {
  return imageErrorLabels[message] ?? message;
}

function safeName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `gocinema-image-${stamp}.png`;
}

export function ImageCreator() {
  const savedKey = localStorage.getItem(imageKeyStorage) || '';
  const [key, setKey] = useState(savedKey);
  const [rememberKey, setRememberKey] = useState(Boolean(savedKey));
  const [prompt, setPrompt] = useState('');
  const [optimizedPrompt, setOptimizedPrompt] = useState('');
  const [optimizeSource, setOptimizeSource] = useState<OptimizeResponse['source'] | ''>('');
  const [size, setSize] = useState('1024x1024');
  const [busy, setBusy] = useState<typeof busyOptimize | typeof busyGenerate | ''>('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [previewingId, setPreviewingId] = useState<number | null>(null);
  const [historyPreview, setHistoryPreview] = useState<HistoryPreview | null>(null);
  const [job, setJob] = useState<ImageJobStatus | null>(null);

  const activePrompt = useMemo(() => (optimizedPrompt || prompt).trim(), [optimizedPrompt, prompt]);

  async function optimize() {
    setError(''); setResult(null); setBusy(busyOptimize);
    try {
      const res = await api<OptimizeResponse>('/api/public/images/optimize-prompt', {
        method: 'POST',
        body: JSON.stringify({ key: key.trim(), prompt: prompt.trim() }),
      });
      setOptimizedPrompt(res.prompt);
      setOptimizeSource(res.source);
    } catch (e: any) {
      setError(friendlyImageError(e?.message || 'Optimize failed'));
    } finally { setBusy(''); }
  }

  async function pollJob(jobId: string) {
    let done = false;
    while (!done) {
      await new Promise(r => setTimeout(r, 1500));
      const status = await api<ImageJobStatus>('/api/public/images/jobs/status', { method: 'POST', body: JSON.stringify({ key: key.trim(), jobId }) });
      setJob(status);
      if (status.status === 'success' && status.result) {
        setResult(status.result); done = true; void loadHistory();
      } else if (status.status === 'error' || status.status === 'cancelled') {
        if (status.status === 'error') setError(friendlyImageError(status.error || 'Generate failed'));
        done = true;
      }
    }
  }

  async function generate() {
    setError(''); setResult(null); setBusy(busyGenerate); setJob(null);
    try {
      if (rememberKey) localStorage.setItem(imageKeyStorage, key.trim());
      else localStorage.removeItem(imageKeyStorage);
      const created = await api<ImageJobStatus>('/api/public/images/jobs', {
        method: 'POST',
        body: JSON.stringify({ key: key.trim(), prompt: activePrompt, size }),
      });
      setJob(created);
      await pollJob(created.jobId);
    } catch (e: any) {
      setError(friendlyImageError(e?.message || 'Generate failed'));
    } finally { setBusy(''); }
  }

  async function cancelJob() {
    if (!job || job.status !== 'queued') return;
    setError('');
    try {
      const res = await api<ImageJobStatus>('/api/public/images/jobs/cancel', { method: 'POST', body: JSON.stringify({ key: key.trim(), jobId: job.jobId }) });
      setJob(res); setBusy('');
    } catch (e: any) { setError(friendlyImageError(e?.message || 'Cancel failed')); }
  }

  async function loadHistory() {
    setError(''); setHistoryLoading(true);
    try {
      const res = await api<HistoryResponse>('/api/public/images/history', { method: 'POST', body: JSON.stringify({ key: key.trim() }) });
      setHistory(res.images); setHistoryLoaded(true);
    } catch (e: any) { setError(friendlyImageError(e?.message || 'Load history failed')); }
    finally { setHistoryLoading(false); }
  }

  async function fetchHistoryImage(id: number) {
    return api<ImageFileResponse>('/api/public/images/download', { method: 'POST', body: JSON.stringify({ key: key.trim(), id }) });
  }

  function imageDataUrl(image: ImageFileResponse) {
    return `data:${image.mimeType};base64,${image.image}`;
  }

  function saveImageFile(image: ImageFileResponse, fallbackName: string) {
    const a = document.createElement('a');
    a.href = imageDataUrl(image);
    a.download = image.filename || fallbackName;
    a.click();
  }

  async function previewHistory(id: number) {
    setError(''); setPreviewingId(id);
    try {
      const res = await fetchHistoryImage(id);
      setHistoryPreview({ ...res, id });
    } catch (e: any) { setError(friendlyImageError(e?.message || 'Preview failed')); }
    finally { setPreviewingId(null); }
  }

  async function downloadHistory(id: number) {
    setError('');
    try {
      const res = await fetchHistoryImage(id);
      saveImageFile(res, `gocinema-image-${id}.png`);
    } catch (e: any) { setError(friendlyImageError(e?.message || 'Download failed')); }
  }

  function download() {
    if (!result) return;
    saveImageFile(result, safeName());
  }

  function clearKey() {
    localStorage.removeItem(imageKeyStorage);
    setRememberKey(false);
    setKey('');
  }

  return <main className="imagePage">
    <section className="imageHero">
      <div>
        <p className="eyebrow">GoCinema Image Studio</p>
        <h1>Tạo ảnh bằng key GoCinema</h1>
        <p>Nhập key được cấp, viết prompt, tối ưu nếu cần, rồi tạo ảnh và tải về.</p>
      </div>
      <a className="ghostLink" href="/check">Kiểm tra key</a>
    </section>

    <section className="imageGrid">
      <div className="imagePanel">
        <label>GoCinema key
          <input value={key} onChange={e => setKey(e.target.value)} placeholder="sk-..." autoComplete="off" />
        </label>
        <div className="keyOptions"><label><input type="checkbox" checked={rememberKey} onChange={e => setRememberKey(e.target.checked)} /> Ghi nhớ key trên máy này</label><button type="button" onClick={clearKey}>Xóa key</button></div>
        <label>Prompt ảnh
          <textarea value={prompt} onChange={e => { setPrompt(e.target.value); setOptimizedPrompt(''); setOptimizeSource(''); }} placeholder={samplePrompt} rows={8} />
        </label>
        <div className="imageRow">
          <label>Size
            <select value={size} onChange={e => setSize(e.target.value)}>
              <option value="1024x1024">1024x1024</option>
              <option value="1024x1536">1024x1536</option>
              <option value="1536x1024">1536x1024</option>
            </select>
          </label>
          <button type="button" onClick={() => setPrompt(samplePrompt)}>Prompt mẫu</button>
        </div>
        <div className="actions imageActions">
          <button type="button" onClick={optimize} disabled={!!busy || !key.trim() || !prompt.trim()}>{busy === busyOptimize ? 'Đang tối ưu...' : 'Tối ưu prompt'}</button>
          <button type="button" onClick={generate} disabled={!!busy || !key.trim() || !activePrompt}>{busy === busyGenerate ? 'Đang tạo ảnh...' : 'Tạo ảnh'}</button>
          <button type="button" onClick={loadHistory} disabled={!!busy || historyLoading || !key.trim()}>{historyLoading ? 'Đang tải...' : 'Ảnh 24h'}</button>
        </div>
        {busy === busyGenerate && <p className="hintText">{job?.status === 'queued' ? `Bạn đang ở hàng đợi #${job.queuePosition ?? '?'}.` : 'Ảnh thường mất 60-120 giây tùy upstream. Giữ trang này mở trong lúc xử lý.'} {job?.status === 'queued' && <button type="button" onClick={cancelJob}>Hủy</button>}</p>}
        {error && <pre className="error">{error}</pre>}
      </div>

      <div className="imagePanel previewPanel">
        <h2>Prompt dùng để tạo</h2>
        <textarea value={activePrompt} onChange={e => { setOptimizedPrompt(e.target.value); }} rows={10} placeholder="Prompt tối ưu sẽ hiện ở đây" />
        {optimizedPrompt && <p className="okText">{optimizeSource === 'fallback' ? 'Đã dùng tối ưu local vì upstream không trả prompt.' : 'Đã tối ưu prompt.'} Có thể sửa trước khi tạo.</p>}
        {result ? <div className="resultBox">
          <img src={imageDataUrl(result)} alt="Generated" />
          <div className="imageActions">
            <button type="button" onClick={download}>Download ảnh</button>
            <span>{fmtBytes(result.bytes)}{result.expiresAt ? ` · lưu đến ${new Date(result.expiresAt).toLocaleString()}` : ''}</span>
          </div>
          <details><summary>Prompt đã gửi upstream</summary><p>{result.prompt}</p></details>
          {result.revisedPrompt && <details><summary>Revised prompt</summary><p>{result.revisedPrompt}</p></details>}
        </div> : <div className={`emptyPreview ${busy === busyGenerate ? 'generating' : ''}`}>
          {busy === busyGenerate ? <div className="generatingPreview" role="status" aria-live="polite">
            <div className="imageLoadingFrame"><span /></div>
            <b>{job?.status === 'queued' ? `Đang chờ hàng đợi #${job.queuePosition ?? '?'}` : 'Đang tạo ảnh...'}</b>
            <p>{job?.status === 'queued' ? 'Bạn có thể hủy trước khi ảnh bắt đầu tạo.' : 'Ảnh sẽ hiện ở đây ngay khi hoàn tất.'}</p>
            {job?.status === 'queued' && <button type="button" onClick={cancelJob}>Hủy tạo ảnh</button>}
          </div> : 'Ảnh sẽ hiện ở đây sau khi tạo.'}
        </div>}
      </div>
    </section>

    <section className="imagePanel historyPanel">
      <div className="historyHead"><h2>Ảnh đã tạo trong 24 giờ</h2><button type="button" onClick={loadHistory} disabled={!!busy || historyLoading || !key.trim()}>{historyLoading ? 'Đang tải...' : 'Refresh'}</button></div>
      {!historyLoaded && <p>Nhập key rồi bấm “Ảnh 24h” để xem ảnh đã tạo bằng key này.</p>}
      {historyLoaded && history.length === 0 && <div className="emptyPreview small">Chưa có ảnh còn hạn 24h.</div>}
      <div className="historyGrid">{history.map(img => <article key={img.id} className="historyItem">
        <div className="historyPreviewTile" aria-hidden="true"><span>PNG</span></div>
        <div className="historyMeta">
          <div><b>#{img.id}</b><span>{img.size || 'Ảnh'}</span></div>
          <span>{img.bytes ? fmtBytes(img.bytes) : '—'}</span>
        </div>
        <span className="historyExpiry">Hết hạn: {img.expiresAt ? new Date(img.expiresAt).toLocaleString() : '24h'}</span>
        <div className="historyActions">
          <button type="button" onClick={() => previewHistory(img.id)} disabled={previewingId === img.id}>{previewingId === img.id ? 'Đang mở...' : 'Xem trước'}</button>
          <button type="button" onClick={() => downloadHistory(img.id)}>Download</button>
        </div>
      </article>)}</div>
    </section>
    {historyPreview && <div className="imagePreviewModal" role="dialog" aria-modal="true" aria-label={`Xem trước ảnh #${historyPreview.id}`} onClick={() => setHistoryPreview(null)}>
      <div className="imagePreviewDialog" onClick={e => e.stopPropagation()}>
        <div className="historyHead"><h2>Ảnh #{historyPreview.id}</h2><button type="button" onClick={() => setHistoryPreview(null)}>Đóng</button></div>
        <img src={imageDataUrl(historyPreview)} alt={`Ảnh đã tạo #${historyPreview.id}`} />
        <div className="imageActions">
          <button type="button" onClick={() => saveImageFile(historyPreview, `gocinema-image-${historyPreview.id}.png`)}>Download</button>
          <span>{fmtBytes(historyPreview.bytes)}{historyPreview.expiresAt ? ` · lưu đến ${new Date(historyPreview.expiresAt).toLocaleString()}` : ''}</span>
        </div>
      </div>
    </div>}
  </main>;
}
