import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { Login, PublicCheck } from './AuthViews';
import { Dashboard } from './Dashboard';
import { ImageCreator } from './ImageCreator';
import type { Lang } from './i18n';
import './style.css';

function App() {
  const [lang, setLang] = useState<Lang>((localStorage.getItem('9rkm:lang') as Lang) || 'vi');
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => localStorage.setItem('9rkm:lang', lang), [lang]);
  useEffect(() => {
    if (location.pathname === '/check') return;
    api<{ authenticated: boolean }>('/api/auth/status').then(r => setAuthed(r.authenticated)).finally(() => setAuthChecked(true));
  }, []);

  if (location.pathname === '/check') return <PublicCheck lang={lang} setLang={setLang} />;
  if (location.pathname === '/images' || location.pathname === '/image') return <ImageCreator />;
  if (!authChecked) return <main />;
  if (!authed) return <Login lang={lang} setLang={setLang} onOk={() => setAuthed(true)} />;
  return <Dashboard lang={lang} setLang={setLang} onLogout={() => setAuthed(false)} />;
}

createRoot(document.getElementById('root')!).render(<App />);
