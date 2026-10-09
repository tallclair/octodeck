// Entry point for the throwaway query-input prototype (frontend/prototype/query-input.html).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import QueryInputPrototype from './QueryInputPrototype';

if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.classList.add('dark');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryInputPrototype />
  </StrictMode>,
);
