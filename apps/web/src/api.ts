/** Address of the Tuma API. Empty means "same site", which is how the local dev proxy works. */
export const API_BASE: string = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
