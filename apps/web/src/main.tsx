import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard, type Metrics } from './Dashboard';
import { API_BASE } from './api';
import { Track, loadTrack } from './Track';
import './styles.css';

const ADMIN_TOKEN_KEY = 'tuma_admin_token';

async function loadMetrics(): Promise<Metrics> {
  const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
  const res = await fetch(`${API_BASE}/admin/metrics`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`metrics ${res.status}`);
  return (await res.json()) as Metrics;
}

function App() {
  const path = window.location.pathname;
  const track = /^\/track\/([A-Za-z0-9_-]+)$/.exec(path);
  if (track?.[1]) return <Track token={track[1]} load={loadTrack} />;
  if (path === '/dashboard') return <Dashboard load={loadMetrics} />;
  return <p className="note">Nothing here. Use the link you were sent.</p>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
