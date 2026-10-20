import { CFG } from './config.mjs';
import { execFileP } from './util.mjs';

// ── model selection (llama.cpp router) ─────────────────────────────────────

export async function llamaModels() {
  const j = await (await fetch(`${CFG.llamaUrl}/v1/models`)).json();
  return (j.data ?? []).map((m) => {
    const args = m.status?.args ?? [];
    const ai = args.indexOf('--ctx-size');
    let ctx = m.meta?.n_ctx ?? (ai >= 0 ? Number(args[ai + 1]) : NaN);
    if (!Number.isFinite(ctx)) {
      const pm = /ctx-size = (\d+)/.exec(m.status?.preset ?? '');
      ctx = pm ? Number(pm[1]) : 0;
    }
    return { id: m.id, loaded: m.status?.value === 'loaded', ctx };
  });
}

// pi's baked default (single source of truth: the settings.json in the image)
let defaultModelCache = { at: 0, value: null };
export async function piDefaultModel() {
  if (Date.now() - defaultModelCache.at < 10 * 60_000) return defaultModelCache.value;
  try {
    const out = await execFileP('docker', ['run', '--rm', '--entrypoint', 'cat', CFG.images.pi, '/root/.pi/agent/settings.json'], { timeout: 15_000 });
    defaultModelCache = { at: Date.now(), value: JSON.parse(out).defaultModel || null };
  } catch {
    defaultModelCache = { at: Date.now(), value: null };
  }
  return defaultModelCache.value;
}

// The default model only if it is loaded; else whatever is loaded (so the
// router never has to lazy-load a model whose VRAM is already occupied);
// else the default (router will load it).
export async function pickModel() {
  let models = [];
  try { models = await llamaModels(); }
  catch (e) { console.error(`[llama] ${e.message} — falling back to default model`); }
  const def = (await piDefaultModel()) ?? null;
  const defM = def ? models.find((m) => m.id === def) : null;
  if (defM?.loaded) return { id: def, ctx: defM.ctx, source: 'default' };
  const loaded = models.find((m) => m.loaded);
  if (loaded) return { id: loaded.id, ctx: loaded.ctx, source: 'loaded' };
  return { id: def ?? 'unknown', ctx: defM?.ctx ?? 0, source: 'default (lazy-load)' };
}
