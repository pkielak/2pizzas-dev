import { CFG } from './config.mjs';

// ── Gitea API ────────────────────────────────────────────────────────────────

export async function apiGet(p, opts = {}) {
  const res = await fetch(`${CFG.giteaApi}${p}`, {
    headers: { Authorization: `token ${opts.token || CFG.agentToken}` },
  });
  if (res.status === 404 && opts.ok404) return null;
  if (!res.ok) throw new Error(`GET ${p} → ${res.status}`);
  return res.json();
}

export async function apiPost(p, body) {
  const res = await fetch(`${CFG.giteaApi}${p}`, {
    method: 'POST',
    headers: { Authorization: `token ${CFG.agentToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${p} → ${res.status}`);
  return res.json();
}
