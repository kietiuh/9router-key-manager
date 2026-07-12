import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { Login, PublicCheck } from './AuthViews';
import { Dashboard } from './Dashboard';
import { KeyDetailPage } from './KeyDetailPage';
import { keyIdFromPath, navigateTo } from './keyDetail';
import type { Lang } from './i18n';
import './style.css';

function usePathname() {
  const [pathname, setPathname] = useState(location.pathname);
  useEffect(() => {
    const onNav = () => setPathname(location.pathname);
    addEventListener('popstate', onNav);
    return () => removeEventListener('popstate', onNav);
  }, []);
  return pathname;
}

function App() {
  const [lang, setLang] = useState<Lang>((localStorage.getItem('9rkm:lang') as Lang) || 'vi');
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const pathname = usePathname();

  useEffect(() => localStorage.setItem('9rkm:lang', lang), [lang]);
  useEffect(() => {
    if (pathname === '/check') return;
    api<{ authenticated: boolean }>('/api/auth/status').then(r => setAuthed(r.authenticated)).finally(() => setAuthChecked(true));
  }, []);

  if (pathname === '/check') return <PublicCheck lang={lang} setLang={setLang} />;
  if (!authChecked) return <main />;
  if (!authed) return <Login lang={lang} setLang={setLang} onOk={() => setAuthed(true)} />;

  const keyId = keyIdFromPath(pathname);
  if (keyId) return <KeyDetailPage keyId={keyId} lang={lang} onBack={() => navigateTo('/')} />;

  return <Dashboard lang={lang} setLang={setLang} onLogout={() => setAuthed(false)} />;
}

createRoot(document.getElementById('root')!).render(<App />);
