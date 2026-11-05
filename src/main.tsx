import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('PageAtlas could not find its app container.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
