import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

/**
 * The API and socket origins default to the page's own origin, so the app
 * works when served behind the same host as the API with no configuration.
 */
const apiBase = import.meta.env.VITE_API_BASE ?? '';
const realtimeUrl =
  import.meta.env.VITE_REALTIME_URL ??
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/realtime`;

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App apiBase={apiBase} realtimeUrl={realtimeUrl} />
    </StrictMode>,
  );
}
