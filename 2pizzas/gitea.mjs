import { CFG } from './config.mjs';

// ── Gitea API ────────────────────────────────────────────────────────────────
// Every call passes the acting identity's token explicitly — there is no
// single default token anymore (per-agent users; see config.mjs).

export async function apiGet(p, opts = {}) {
  const res = await fetch(`${CFG.giteaApi}${p}`, {
    headers: { Authorization: `token ${opts.token}` },
  });
  if (res.status === 404 && opts.ok404) return null;
  if (!res.ok) throw new Error(`GET ${p} → ${res.status}`);
  return res.json();
}

export async function apiPost(p, body, opts = {}) {
  const res = await fetch(`${CFG.giteaApi}${p}`, {
    method: 'POST',
    headers: { Authorization: `token ${opts.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${p} → ${res.status}`);
  return res.json();
}
