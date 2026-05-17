import { useMemo, useState } from 'react';
import { api } from './api';
import { bytes as fmtBytes } from './format';

type OptimizeResponse = { prompt: string; source: 'optimized' | 'fallback' };
type GenerateResponse = { image: string; mimeType: string; filename: string; revisedPrompt?: string; prompt: string; bytes: number; expiresAt?: string };
type HistoryItem = { id: number; model: string; size?: string; promptPreview?: string; bytes?: number; estimatedTotalTokens?: number; createdAt: string; expiresAt?: string };
type HistoryResponse = { images: HistoryItem[] };

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
  const savedKey = localStorage.getItem('gocinema:imageKey') || '';
  const [key, setKey] = useState(savedKey);
  const [rememberKey, setRememberKey] = useState(Boolean(savedKey));
  const [prompt, setPrompt] = useState('');
  const [optimizedPrompt, setOptimizedPrompt] = useState('');
  const [optimizeSource, setOptimizeSource] = useState<OptimizeResponse['source'] | ''>('');
  const [size, setSize] = useState('1024x1024');
  const [busy, setBusy] = useState<'optimize' | 'generate' | ''>('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const activePrompt = useMemo(() => (optimizedPrompt || prompt).trim(), [optimizedPrompt, prompt]);

  async function optimize() {
    setError(''); setResult(null); setBusy('optimize');
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

  async function generate() {
    setError(''); setResult(null); setBusy('generate');
    try {
      if (rememberKey) localStorage.setItem('gocinema:imageKey', key.trim());
      else localStorage.removeItem('gocinema:imageKey');
      const res = await api<GenerateResponse>('/api/public/images/generate', {
        method: 'POST',
        body: JSON.stringify({ key: key.trim(), prompt: activePrompt, size }),
      });
      setResult(res);
      void loadHistory();
    } catch (e: any) {
      setError(friendlyImageError(e?.message || 'Generate failed'));
    } finally { setBusy(''); }
  }

  async function loadHistory() {
    setError(''); setBusy('optimize');
    try {
      const res = await api<HistoryResponse>('/api/public/images/history', { method: 'POST', body: JSON.stringify({ key: key.trim() }) });
      setHistory(res.images); setHistoryLoaded(true);
    } catch (e: any) { setError(friendlyImageError(e?.message || 'Load history failed')); }
    finally { setBusy(''); }
  }

  async function downloadHistory(id: number) {
    setError('');
    try {
      const res = await api<GenerateResponse>('/api/public/images/download', { method: 'POST', body: JSON.stringify({ key: key.trim(), id }) });
      const a = document.createElement('a');
      a.href = `data:${res.mimeType};base64,${res.image}`;
      a.download = res.filename || `gocinema-image-${id}.png`;
      a.click();
    } catch (e: any) { setError(friendlyImageError(e?.message || 'Download failed')); }
  }

  function download() {
    if (!result) return;
    const a = document.createElement('a');
    a.href = `data:${result.mimeType};base64,${result.image}`;
    a.download = result.filename || safeName();
    a.click();
  }

  function clearKey() {
    localStorage.removeItem('gocinema:imageKey');
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
          <button type="button" onClick={optimize} disabled={!!busy || !key.trim() || !prompt.trim()}>{busy === 'optimize' ? 'Đang tối ưu...' : 'Tối ưu prompt'}</button>
          <button type="button" onClick={generate} disabled={!!busy || !key.trim() || !activePrompt}>{busy === 'generate' ? 'Đang tạo ảnh...' : 'Tạo ảnh'}</button>
          <button type="button" onClick={loadHistory} disabled={!!busy || !key.trim()}>{busy === 'optimize' && historyLoaded ? 'Đang tải...' : 'Ảnh 24h'}</button>
        </div>
        {busy === 'generate' && <p className="hintText">Ảnh thường mất 60-120 giây tùy upstream. Giữ trang này mở trong lúc xử lý.</p>}
        {error && <pre className="error">{error}</pre>}
      </div>

      <div className="imagePanel previewPanel">
        <h2>Prompt dùng để tạo</h2>
        <textarea value={activePrompt} onChange={e => { setOptimizedPrompt(e.target.value); }} rows={10} placeholder="Prompt tối ưu sẽ hiện ở đây" />
        {optimizedPrompt && <p className="okText">{optimizeSource === 'fallback' ? 'Đã dùng tối ưu local vì upstream không trả prompt.' : 'Đã tối ưu prompt.'} Có thể sửa trước khi tạo.</p>}
        {result ? <div className="resultBox">
          <img src={`data:${result.mimeType};base64,${result.image}`} alt="Generated" />
          <div className="imageActions">
            <button type="button" onClick={download}>Download ảnh</button>
            <span>{fmtBytes(result.bytes)}{result.expiresAt ? ` · lưu đến ${new Date(result.expiresAt).toLocaleString()}` : ''}</span>
          </div>
          <details><summary>Prompt đã gửi upstream</summary><p>{result.prompt}</p></details>
          {result.revisedPrompt && <details><summary>Revised prompt</summary><p>{result.revisedPrompt}</p></details>}
        </div> : <div className="emptyPreview">Ảnh sẽ hiện ở đây sau khi tạo.</div>}
      </div>
    </section>

    <section className="imagePanel historyPanel">
      <div className="historyHead"><h2>Ảnh đã tạo trong 24 giờ</h2><button type="button" onClick={loadHistory} disabled={!!busy || !key.trim()}>Refresh</button></div>
      {!historyLoaded && <p>Nhập key rồi bấm “Ảnh 24h” để xem ảnh đã tạo bằng key này.</p>}
      {historyLoaded && history.length === 0 && <div className="emptyPreview small">Chưa có ảnh còn hạn 24h.</div>}
      <div className="historyGrid">{history.map(img => <article key={img.id} className="historyItem">
        <div><b>#{img.id}</b><span>{img.size}</span><p>{img.promptPreview}</p></div>
        <span>{img.bytes ? fmtBytes(img.bytes) : ''}</span>
        <span>Hết hạn: {img.expiresAt ? new Date(img.expiresAt).toLocaleString() : '24h'}</span>
        <button type="button" onClick={() => downloadHistory(img.id)}>Download</button>
      </article>)}</div>
    </section>
  </main>;
}
