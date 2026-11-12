'use client';

/** Session expired (nginx auth_request → 401): go to the shared login page and come back here. */
export function toLogin() {
  const host = window.location.hostname;
  if (!host.endsWith('mcc.babochkin.com')) return; // ssh tunnel (localhost) has no login
  window.location.href = `https://auth.mcc.babochkin.com/login?rd=${encodeURIComponent(window.location.href)}`;
}

/** After the WebSocket dropped: is it because we are logged out? */
export async function checkAuth() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store', redirect: 'manual' });
    if (r.status === 401) toLogin();
  } catch {
    /* network down — keep retrying */
  }
}
