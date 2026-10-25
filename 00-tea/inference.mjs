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
export function readRegistry() {
  if (regCache.value && Date.now() - regCache.at < 5_000) return regCache.value;
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
