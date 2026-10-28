import { CFG } from './config.mjs';
import { execFileP } from './util.mjs';
import fs from 'node:fs';

// ── inference backend registry ─────────────────────────────────────────────
// Single source of truth: inference.json (repo root, mounted read-only into
// this container). Each backend is any OpenAI-compatible /v1 endpoint — a
// local llama.cpp router, vLLM, Ollama, OpenRouter, ... The agent images
// bake the SAME list (setup.sh generates their models.json / opencode.json
// from this file), so a per-task `--model <provider>/<id>` override only
// works for providers baked in at image build time — checkBakedSync() turns
// that mismatch into a log warning instead of an opaque agent failure.
//
// Fallback: without the file (or with an empty one) the legacy single
// backend from LLAMA_CPP_URL is used, so an un-migrated stack keeps working.

let regCache = { at: 0, value: null };
export function readRegistry(force = false) {
  if (!force && regCache.value && Date.now() - regCache.at < 5_000) return regCache.value;
  let backends = null;
  try {
    const j = JSON.parse(fs.readFileSync(CFG.inferenceFile, 'utf8'));
    backends = (j.backends ?? [])
      .map((b, i) => ({
        id: b.id,                                   // provider ID baked into agent images
        url: String(b.url).replace(/\/+$/, ''),
        apiKey: b.apiKey ?? '',
        priority: b.priority ?? i + 1,              // 1 = tried first
        defaultModel: b.defaultModel ?? null,       // bare model id (no provider prefix)
      }))
      .filter((b) => b.id && b.url)
      .sort((a, b) => a.priority - b.priority);
  } catch (e) {
    console.error(`[inference] ${CFG.inferenceFile}: ${e.message} — falling back to LLAMA_CPP_URL`);
  }
  if (!backends?.length) backends = [{ id: 'llama.cpp', url: CFG.llamaUrl, apiKey: '', priority: 1, defaultModel: null }];
  regCache = { at: Date.now(), value: backends };
  return backends;
}

// models of one backend; `reportsLoad` is true only for endpoints that
// expose load state (the llama.cpp router does — others are always "ready")
export async function backendModels(b) {
  const res = await fetch(`${b.url}/v1/models`, {
    headers: b.apiKey ? { authorization: `Bearer ${b.apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`GET /v1/models → ${res.status}`);
  const j = await res.json();
  return (j.data ?? []).map((m) => {
    const args = m.status?.args ?? [];
    const ai = args.indexOf('--ctx-size');
    let ctx = m.meta?.n_ctx ?? (ai >= 0 ? Number(args[ai + 1]) : NaN);
    if (!Number.isFinite(ctx)) {
      const pm = /ctx-size = (\d+)/.exec(m.status?.preset ?? '');
      ctx = pm ? Number(pm[1]) : 0;
    }
    return { id: m.id, loaded: m.status?.value === 'loaded', reportsLoad: m.status?.value != null, ctx };
  });
}

// Reachability probe FROM 2pizzas's own network vantage — the container that
// actually calls the backend, NOT the host. This is the diagnostic for the
// #1 inference misconfiguration: a backend bound to the host's
// 127.0.0.1/localhost is INVISIBLE to every container (127.0.0.1 inside a
// container is that container's own loopback, not the host's). A backend must
// be bound to a ROUTABLE host IP (tailscale/LAN) to be reachable from 2pizzas
// and the job containers. Used by the /backends UI "test" buttons and
// POST /api/backends/test. Always resolves (never throws): the result object
// carries ok/error/hint so the caller can render the diagnostic.
export async function probeBackend(b) {
  const url = String(b.url ?? '').replace(/\/+$/, '');
  let host = url;
  try { host = new URL(url).host; } catch { /* not a URL — keep raw */ }
  const started = Date.now();
  const res = { ok: false, url, host, ms: 0 };
  try {
    const r = await fetch(`${url}/v1/models`, {
      headers: b.apiKey ? { authorization: `Bearer ${b.apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    res.ms = Date.now() - started;
    res.status = r.status;
    if (!r.ok) { res.error = `GET /v1/models → ${r.status}`; return res; }
    const j = await r.json();
    const models = (j.data ?? []).map((m) => m.id);
    res.ok = true; res.models = models; res.count = models.length;
    return res;
  } catch (e) {
    res.ms = Date.now() - started;
    res.error = e.cause?.message || e.message;
    if (/(^|\.)localhost$|^127\./.test(host)) {
      res.hint = `host '${host}' is the HOST's loopback — a container (2pizzas, job containers) CANNOT reach 127.0.0.1/localhost; inside a container that address is the container's own loopback. Bind the server to a routable host IP (tailscale/LAN, e.g. <tailscale-ip> or 192.168.x.x) and point the backend at THAT url.`;
    }
    return res;
  }
}

// pi's baked default (single source of truth: the settings.json in the image)
let piDefCache = { at: 0, value: null };
export async function piDefaultModel() {
  if (Date.now() - piDefCache.at < 10 * 60_000) return piDefCache.value;
  try {
    const out = await execFileP('docker', ['run', '--rm', '--entrypoint', 'cat', CFG.images.pi, '/root/.pi/agent/settings.json'], { timeout: 15_000 });
    const j = JSON.parse(out);
    piDefCache = { at: Date.now(), value: j.defaultModel ? { provider: j.defaultProvider ?? 'llama.cpp', id: j.defaultModel } : null };
  } catch {
    piDefCache = { at: Date.now(), value: null };
  }
  return piDefCache.value;
}

// Walk backends by priority. Per backend:
//   reports load state (llama.cpp router) → default if loaded → else whatever
//     is loaded (never force a lazy-load onto occupied VRAM) → else default
//     (router lazy-loads)
//   no load state (external API)         → its default (or first listed)
// Unreachable backends are SKIPPED (failover to the next priority).
export async function pickModel() {
  const backends = readRegistry();
  const piDef = (await piDefaultModel()) ?? null;
  for (const b of backends) {
    let ms;
    try { ms = await backendModels(b); }
    catch (e) { console.error(`[inference] ${b.id} (${b.url}): ${e.message} — trying next backend`); continue; }
    if (!ms.length) continue;
    const defId = b.defaultModel ?? (b.id === piDef?.provider ? piDef.id : null) ?? ms[0].id;
    const defM = ms.find((m) => m.id === defId) ?? null;
    if (!ms.some((m) => m.reportsLoad)) {
      return { id: defM?.id ?? ms[0].id, ctx: defM?.ctx ?? 0, provider: b.id, source: `${b.id} (no load state)` };
    }
    if (defM?.loaded) return { id: defM.id, ctx: defM.ctx, provider: b.id, source: `${b.id} default (loaded)` };
    const loaded = ms.find((m) => m.loaded);
    if (loaded) return { id: loaded.id, ctx: loaded.ctx, provider: b.id, source: `${b.id} loaded` };
    return { id: defM?.id ?? ms[0].id, ctx: defM?.ctx ?? 0, provider: b.id, source: `${b.id} default (lazy-load)` };
  }
  // nothing reachable — keep the old behaviour: the pi baked default
  return { id: piDef?.id ?? 'unknown', ctx: 0, provider: piDef?.provider ?? 'none', source: 'no backend reachable' };
}

// The per-task --model override must name a provider+model present in the
// BAKED image config (pi: models.json, opencode: opencode.json) — a missing
// model fails with an opaque agent error. Verify once an hour.
let bakedCache = { at: 0, pi: null, oc: null };
async function bakedProviders() {
  if (bakedCache.pi && Date.now() - bakedCache.at < 10 * 60_000) return bakedCache;
  const [piOut, ocOut] = await Promise.all([
    execFileP('docker', ['run', '--rm', '--entrypoint', 'cat', CFG.images.pi, '/root/.pi/agent/models.json'], { timeout: 15_000 }).catch(() => null),
    execFileP('docker', ['run', '--rm', '--entrypoint', 'cat', CFG.images.opencode, '/root/.config/opencode/opencode.json'], { timeout: 15_000 }).catch(() => null),
  ]);
  const parse = (out) => {
    try {
      const j = JSON.parse(out);
      const provs = {};
      for (const [p, cfg] of Object.entries(j.providers ?? {})) provs[p] = new Set((cfg.models ?? []).map((m) => m.id ?? m));
      for (const [p, cfg] of Object.entries(j.provider ?? {})) provs[p] = new Set(Object.keys(cfg.models ?? {}));
      return provs;
    } catch { return null; }
  };
  bakedCache = { at: Date.now(), pi: parse(piOut), oc: parse(ocOut) };
  return bakedCache;
}

// returns a warning string when the picked model is not in the baked config
// of the agent's image (image out of sync — run ./setup.sh --rebuild)
export async function checkBakedSync(agent, sel) {
  const { pi, oc } = await bakedProviders();
  const table = agent === 'opencode' || agent === 'review' ? oc : pi;
  if (!table) return null; // image unreadable — don't block on it
  const models = table[sel.provider];
  if (!models) return `provider '${sel.provider}' is not baked into ${agent}'s image config — run ./setup.sh --rebuild after editing inference.json`;
  if (!models.has(sel.id)) return `model '${sel.provider}/${sel.id}' is not in the baked ${agent} image config — run ./setup.sh --rebuild after editing inference.json`;
  return null;
}

// provider IDs present in the baked agent image configs right now (for the
// "not baked — run ./setup.sh --rebuild" badge in the UI)
export async function bakedProviderIds() {
  const { pi, oc } = await bakedProviders();
  return [...new Set([...Object.keys(pi ?? {}), ...Object.keys(oc ?? {})])];
}

// ── registry mutations (UI: /api/backends) ─────────────────────────
// CFG.inferenceFile is a BIND-MOUNTED host file: writes must be IN PLACE
// (truncate+write). An atomic rename would swap the inode and the container
// would keep seeing the old file forever.
const B_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
function normalizeBackend(b) {
  if (!B_ID_RE.test(String(b.id ?? ''))) throw new Error('backend id: letters/digits/.-_ (e.g. llama.cpp, openrouter)');
  if (!/^https?:\/\//.test(String(b.url ?? ''))) throw new Error('backend url: http(s):// required');
  b.id = String(b.id).toLowerCase();
  b.url = String(b.url).replace(/\/+$/, '');
  b.apiKey = String(b.apiKey ?? '');
  b.defaultModel = b.defaultModel || null;
  b.priority = Number(b.priority) || 0;
  return b;
}
function writeRegistry(r) {
  fs.writeFileSync(CFG.inferenceFile, JSON.stringify(r, null, 2) + '\n'); // in place, never rename
  regCache = { at: 0, value: null }; // invalidate the read cache immediately
}
export async function registryFresh() { return { backends: readRegistry(true) }; }
export async function addBackend(fields) {
  const r = await registryFresh();
  const b = normalizeBackend({ ...fields });
  if (r.backends.some((x) => x.id === b.id)) throw new Error(`backend ${b.id} already exists`);
  b.priority = r.backends.reduce((m, x) => Math.max(m, x.priority), 0) + 1; // new backends go last
  r.backends.push(b);
  writeRegistry(r);
  console.log(`[inference] + backend ${b.id} (${b.url}) p${b.priority}`);
  return r;
}
export async function updateBackend(id, fields) {
  const r = await registryFresh();
  const b = r.backends.find((x) => x.id === id);
  if (!b) throw new Error(`no backend ${id}`);
  for (const k of ['id', 'url', 'apiKey', 'defaultModel', 'priority']) {
    if (fields[k] !== undefined && fields[k] !== b[k]) {
      if (k === 'id' && r.backends.some((x) => x.id === String(fields[k]).toLowerCase())) throw new Error(`backend ${fields[k]} already exists`);
      b[k] = fields[k];
    }
  }
  normalizeBackend(b);
  writeRegistry(r);
  console.log(`[inference] ~ backend ${b.id} (${b.url}) p${b.priority}`);
  return r;
}
export async function deleteBackend(id) {
  const r = await registryFresh();
  if (r.backends.length <= 1) throw new Error('refusing to remove the last backend');
  const i = r.backends.findIndex((x) => x.id === id);
  if (i < 0) throw new Error(`no backend ${id}`);
  r.backends.splice(i, 1);
  r.backends.forEach((x, n) => { x.priority = n + 1; }); // keep priorities dense
  writeRegistry(r);
  console.log(`[inference] - backend ${id}`);
  return r;
}
export async function moveBackend(id, dir) {
  const r = await registryFresh();
  const i = r.backends.findIndex((x) => x.id === id);
  const j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= r.backends.length) return r;
  [r.backends[i], r.backends[j]] = [r.backends[j], r.backends[i]];
  r.backends.forEach((x, n) => { x.priority = n + 1; });
  writeRegistry(r);
  console.log(`[inference] ⇅ backend ${id} ${dir} → p${i + (dir === 'up' ? -1 : 1) + 1}`);
  return r;
}
