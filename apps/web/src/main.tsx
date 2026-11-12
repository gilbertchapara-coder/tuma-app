import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard, type Metrics } from './Dashboard';
import type { ClaimsApi, Claim } from './ClaimsAdmin';
import type { AdminCountry, CountriesApi } from './CountriesAdmin';
import type { Insight, InsightsApi } from './InsightsAdmin';
import type { LockedCodesApi, LockedParcel } from './LockedCodes';
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

async function adminCall<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

const lockedCodesApi: LockedCodesApi = {
  lookup: async (reference) => (await adminCall<{ parcels: LockedParcel[] }>('GET', `/admin/parcels/lookup?ref=${encodeURIComponent(reference.trim())}`)).parcels,
  locked: async () => (await adminCall<{ parcels: LockedParcel[] }>('GET', '/admin/codes/locked')).parcels,
  unlock: async (parcelId, which) => {
    await adminCall('POST', `/admin/parcels/${parcelId}/unlock`, { which });
  },
};

const countriesApi: CountriesApi = {
  list: async () => (await adminCall<{ countries: AdminCountry[] }>('GET', '/admin/countries')).countries,
  save: async (code, settings) => {
    await adminCall('PUT', `/admin/countries/${code}`, settings);
  },
};

const claimsApi: ClaimsApi = {
  open: async () => (await adminCall<{ claims: Claim[] }>('GET', '/claims?status=open')).claims,
  dismiss: async (claimId) => {
    await adminCall('POST', `/claims/${claimId}/dismiss`, {});
  },
};

const insightsApi: InsightsApi = {
  list: () => adminCall<{ connected: boolean; insights: Insight[] }>('GET', '/admin/insights'),
  refresh: () => adminCall<{ added: number; failedTopics: string[] }>('POST', '/admin/insights/refresh', {}),
};

function App() {
  const path = window.location.pathname;
  const track = /^\/track\/([A-Za-z0-9_-]+)$/.exec(path);
  if (track?.[1]) return <Track token={track[1]} load={loadTrack} />;
  if (path === '/dashboard') return <Dashboard load={loadMetrics} codes={lockedCodesApi} countries={countriesApi} claims={claimsApi} insights={insightsApi} />;
  return <p className="note">Nothing here. Use the link you were sent.</p>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
