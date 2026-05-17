import { useMemo, useState } from 'react';
import { api } from './api';

type OptimizeResponse = { prompt: string; source: 'optimized' | 'fallback' };
type GenerateResponse = { image: string; mimeType: string; filename: string; revisedPrompt?: string; prompt: string; bytes: number };

const samplePrompt = 'A cinematic Vietnamese dragon made of golden light flying above Ha Long Bay at sunrise, ultra detailed, magical atmosphere';

function safeName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `gocinema-image-${stamp}.png`;
}

export function ImageCreator() {
  const [key, setKey] = useState(localStorage.getItem('gocinema:imageKey') || '');
  const [prompt, setPrompt] = useState('');
  const [optimizedPrompt, setOptimizedPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [busy, setBusy] = useState<'optimize' | 'generate' | ''>('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<GenerateResponse | null>(null);

  const activePrompt = useMemo(() => (optimizedPrompt || prompt).trim(), [optimizedPrompt, prompt]);

  async function optimize() {
    setError(''); setResult(null); setBusy('optimize');
    try {
      const res = await api<OptimizeResponse>('/api/public/images/optimize-prompt', {
        method: 'POST',
        body: JSON.stringify({ key: key.trim(), prompt: prompt.trim() }),
      });
      setOptimizedPrompt(res.prompt);
    } catch (e: any) {
      setError(e?.message || 'Optimize failed');
    } finally { setBusy(''); }
  }

  async function generate() {
    setError(''); setResult(null); setBusy('generate');
    try {
      localStorage.setItem('gocinema:imageKey', key.trim());
      const res = await api<GenerateResponse>('/api/public/images/generate', {
        method: 'POST',
        body: JSON.stringify({ key: key.trim(), prompt: activePrompt, size }),
      });
      setResult(res);
    } catch (e: any) {
      setError(e?.message || 'Generate failed');
    } finally { setBusy(''); }
  }

  function download() {
    if (!result) return;
    const a = document.createElement('a');
    a.href = `data:${result.mimeType};base64,${result.image}`;
    a.download = result.filename || safeName();
    a.click();
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
        <label>Prompt ảnh
          <textarea value={prompt} onChange={e => { setPrompt(e.target.value); setOptimizedPrompt(''); }} placeholder={samplePrompt} rows={8} />
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
        </div>
        {error && <pre className="error">{error}</pre>}
      </div>

      <div className="imagePanel previewPanel">
        <h2>Prompt dùng để tạo</h2>
        <textarea value={activePrompt} onChange={e => { setOptimizedPrompt(e.target.value); }} rows={10} placeholder="Prompt tối ưu sẽ hiện ở đây" />
        {optimizedPrompt && <p className="okText">Đã tối ưu. Có thể sửa prompt này trước khi tạo.</p>}
        {result ? <div className="resultBox">
          <img src={`data:${result.mimeType};base64,${result.image}`} alt="Generated" />
          <div className="imageActions">
            <button type="button" onClick={download}>Download ảnh</button>
            <span>{Math.round(result.bytes / 1024)} KB</span>
          </div>
          {result.revisedPrompt && <details><summary>Revised prompt</summary><p>{result.revisedPrompt}</p></details>}
        </div> : <div className="emptyPreview">Ảnh sẽ hiện ở đây sau khi tạo.</div>}
      </div>
    </section>
  </main>;
}
