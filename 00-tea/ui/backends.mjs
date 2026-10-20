import { CFG } from '../config.mjs';
import { llamaModels, piDefaultModel } from '../llama.mjs';
import { esc, fmtTok } from './layout.mjs';

export async function backendsPage() {
  const agentRows = [
    { agent: 'pi', image: CFG.images.pi, note: 'model picked per task from the inference backend (below)' },
    { agent: 'opencode', image: CFG.images.opencode, note: 'model picked per task from the inference backend (below), overriding the baked config' },
    { agent: 'review', image: CFG.images.review, note: `read-only reviewer (opencode + code-review skill) — triggered after agent pushes, max ${CFG.reviewMaxRounds} rounds` },
  ];
  // inference backends — one local llama.cpp router for now; the list shape is
  // what a second endpoint on the network will slot into later
  const backends = [{ name: 'llama.cpp', url: CFG.llamaUrl, models: null, error: null }];
  for (const b of backends) {
    try { b.models = await llamaModels(); }
    catch (e) { b.error = e.message; }
  }
  const def = await piDefaultModel();

  const agents = `<h2>agents</h2><div class="list">${agentRows.map((a) => `<div class="item">
    <div class="l1">@${esc(a.agent)}</div>
    <div class="l2">image <code>${esc(a.image)}</code> · ${a.note}</div>
  </div>`).join('')}</div>
<p class="meta">every job runs one-shot in a gVisor (runsc) sandbox; 00-tea itself runs unsandboxed on the host</p>`;

  const provs = backends.map((b) => {
    const rows = b.models
      ? b.models.map((m) => `<div class="item">
        <div class="l1">${esc(m.id)}${m.id === def ? ' <span class="meta">★ pi default</span>' : ''} <span class="${m.loaded ? 'running' : 'queued'}">${m.loaded ? 'loaded' : 'idle'}</span></div>
        <div class="l2">ctx ${m.ctx ? fmtTok(m.ctx) : 'unknown'}</div>
      </div>`).join('')
      : `<div class="item"><div class="l2">unreachable: <span class="err">${esc(b.error)}</span></div></div>`;
    return `<p class="meta">${esc(b.name)} — <code>${esc(b.url)}</code></p><div class="list">${rows}</div>`;
  }).join('');

  return `<h1>backends</h1>${agents}
<h2>inference</h2>${provs}
<p class="meta">model selection for pi: baked default if it is loaded → else whichever model is loaded → else the default (lazy-load). one local llama.cpp endpoint for now; the backend list is shaped to accept another local endpoint on the network later.</p>`;
}
