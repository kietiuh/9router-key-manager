import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <main style={{ fontFamily: 'system-ui', padding: 24 }}><h1>9router Key Manager</h1><p>Phase 1 scaffold ready.</p></main>;
}

createRoot(document.getElementById('root')!).render(<App />);
