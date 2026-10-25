import { CFG } from '../config.mjs';
import { readRegistry, backendModels, pickModel, piDefaultModel } from '../inference.mjs';
import { esc, fmtTok } from './layout.mjs';

export async function backendsPage() {
  const agentRows = [
    { agent: 'pi', image: CFG.images.pi, note: 'model picked per task from the inference backends (below)' },
    { agent: 'opencode', image: CFG.images.opencode, note: 'model picked per task from the inference backends (below), overriding the baked config' },
    { agent: 'review', image: CFG.images.review, note: `read-only reviewer (opencode + code-review skill) — triggered after agent pushes, max ${CFG.reviewMaxRounds} rounds` },
  ];
  // the registry (inference.json) — every backend is an OpenAI-compatible
  // /v1 endpoint; the agent images bake the same list (setup.sh)
  const backends = readRegistry();
  for (const b of backends) {
    try { b.models = await backendModels(b); }
    catch (e) { b.error = e.message; b.models = null; }
  }
  const def = await piDefaultModel();
  const next = await pickModel();

  const agents = `<h2>agents</h2><div class="list">${agentRows.map((a) => `<div class="item">
    <div class="l1">@${esc(a.agent)}</div>
    <div class="l2">image <code>${esc(a.image)}</code> · ${a.note}</div>
  </div>`).join('')}</div>
<p class="meta">every job runs one-shot in a gVisor (runsc) sandbox; 00-tea itself runs unsandboxed on the host</p>`;

  const provs = backends.map((b) => {
    const rows = b.models
      ? b.models.map((m) => `<div class="item">
        <div class="l1">${esc(b.id)}/${esc(m.id)}${def && def.provider === b.id && def.id === m.id ? ' <span class="meta">★ pi default</span>' : ''} ${m.reportsLoad ? `<span class="${m.loaded ? 'running' : 'queued'}">${m.loaded ? 'loaded' : 'idle'}</span>` : ''}</div>
        <div class="l2">ctx ${m.ctx ? fmtTok(m.ctx) : 'unknown'}</div>
      </div>`).join('')
      : `<div class="item"><div class="l2">unreachable: <span class="err">${esc(b.error)}</span></div></div>`;
    return `<p class="meta">${esc(b.id)} <span class="meta">priority ${b.priority}</span> — <code>${esc(b.url)}</code>${b.apiKey ? ' <span class="meta">· keyed</span>' : ''}</p><div class="list">${rows}</div>`;
  }).join('');

  return `${agents}
<h2>inference backends</h2>${provs}
<p class="meta">selection: backends are walked by priority — one that reports load state (llama.cpp router): its default if loaded → else whatever is loaded → else the default (lazy-load); a backend without load state: its default. unreachable backends are skipped (failover). next task will use <code>${esc(next.provider)}/${esc(next.id)}</code> (${esc(next.source)}). the agent images bake this list — after editing <code>inference.json</code> run <code>./setup.sh --rebuild</code>.</p>`;
}
