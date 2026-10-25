import { readRegistry, backendModels, pickModel, piDefaultModel, bakedProviderIds } from '../inference.mjs';
import { CFG } from '../config.mjs';

// /backends — the inference setup, and its admin surface:
//   - every backend from inference.json (priority, url, model list,
//     load state, api key presence) — 00-tea re-reads the file on change,
//     so changes made here apply to the NEXT task without a restart
//   - a "not baked" badge: the AGENT IMAGES bake the registry at build
//     time — a backend added here only works inside the agents after
//     `./setup.sh --rebuild` (checkBakedSync() logs the same warning
//     per task until then)
//   - "next task will use X" — the live pickModel() result
//   - add / edit / move / delete (POST/PATCH/DELETE /api/backends)
export async function backendsPage() {
  const backends = readRegistry();
  const [picked, piDef] = await Promise.all([pickModel(), piDefaultModel()]);
  const baked = await bakedProviderIds();
  const modelsP = backends.map((b) => backendModels(b).catch(() => null));
  const models = await Promise.all(modelsP);
  const first = backends[0];
  const firstModels = models[0] ?? [];
  const loadedIds = new Set(firstModels.filter((m) => m.loaded).map((m) => m.id));

  const row = (b, ms, i) => {
    const modelsHtml = ms
      ? ms.map((m) => `<li>${m.id}
          ${m.loaded ? '<span class="badge badge-success">loaded</span>' : m.reportsLoad ? '<span class="meta">idle</span>' : ''}
          ${b.defaultModel === m.id ? '<span class="meta">★ default</span>' : ''}</li>`).join('')
      : '<li class="meta">unreachable</li>';
    const notBaked = !baked.includes(b.id);
    return `<div class="card" id="backend-${b.id}" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <strong>${b.id}</strong>
        <span class="meta">priority ${b.priority}</span>
        ${b.id === piDef?.provider && b.defaultModel === piDef.id ? '<span class="badge badge-success">★ pi default</span>' : ''}
        ${b.apiKey ? '<span class="badge badge-info">keyed</span>' : ''}
        ${notBaked ? '<span class="badge" style="background:#8a5b00;color:#fff" title="add it via ./setup.sh --rebuild — until then tasks cannot use this backend">not baked</span>' : ''}
        <span class="meta">${b.url}</span>
        <span style="flex:1"></span>
        <button class="bbtn" data-act="up" data-id="${b.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="bbtn" data-act="down" data-id="${b.id}" ${i === backends.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="bbtn" data-act="edit" data-id="${b.id}">edit</button>
        <button class="bbtn bbtn-danger" data-act="del" data-id="${b.id}" ${backends.length <= 1 ? 'disabled' : ''} title="remove">✕</button>
      </div>
      <div class="bform edit-form" id="edit-${b.id}" style="display:none">
        <input type="text" data-f="url" value="${b.url}" style="flex:2;min-width:200px" placeholder="url">
        <input type="password" data-f="apiKey" value="${b.apiKey}" style="flex:1;min-width:120px" placeholder="api key (empty = none)">
        <input type="text" data-f="defaultModel" value="${b.defaultModel ?? ''}" style="flex:1;min-width:140px" placeholder="default model (empty = auto)">
        <button class="bbtn bbtn-primary" data-act="save" data-id="${b.id}">save</button>
        <button class="bbtn" data-act="cancel" data-id="${b.id}">cancel</button>
      </div>
      <details style="margin-top:8px"><summary class="meta" style="cursor:pointer">${ms ? `${ms.length} models` : 'models'}</summary>
        <ul style="margin:8px 0 0 18px;padding:0;list-style:none">${modelsHtml}</ul>
      </details>
    </div>`;
  };

  return {
    html: `
    <style>
    .bbtn{background:var(--color-button-secondary-background,#222);border:1px solid var(--color-button-secondary-border,#444);color:var(--color-button-secondary-text,#ddd);border-radius:var(--radius-sm,6px);padding:3px 10px;cursor:pointer;font-size:12px}
    .bbtn:hover:not(:disabled){border-color:var(--color-primary,#7ab);color:var(--color-text,#fff)}
    .bbtn:disabled{opacity:.4;cursor:default}
    .bbtn-danger:hover:not(:disabled){border-color:#d66;color:#f99}
    .bbtn-primary{background:var(--color-button-primary-background,var(--color-primary,#3a7));border-color:transparent;color:var(--color-button-primary-text,#fff)}
    .bform{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
    .bform input{background:var(--color-input-background,#0c0c0c);border:1px solid var(--color-input-border,#333);border-radius:8px;color:var(--color-input-text,#ddd);padding:7px 10px;font-size:13px}
    .bform input:focus{outline:none;border-color:var(--color-primary,#7ab)}
    .badge{border-radius:9px;padding:1px 8px;font-size:11px;background:#333;color:#ddd}
    .badge-success{background:#0a5;color:#fff}
    .badge-info{background:#246;color:#fff}
    </style>
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <strong>next task will use</strong>
        <code>${picked.provider}/${picked.id}</code>
        <span class="meta">(${picked.source})</span>
      </div>
    </div>
    ${backends.map((b, i) => row(b, models[i], i)).join('')}
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <strong>add a backend</strong>
        <span class="meta">any OpenAI-compatible /v1 endpoint — local llama.cpp, vLLM, Ollama, OpenRouter, …</span>
      </div>
      <div class="bform" id="add-form">
        <input type="text" data-f="id" placeholder="id (e.g. openrouter)" style="flex:1;min-width:120px">
        <input type="text" data-f="url" placeholder="url (e.g. https://openrouter.ai/api)" style="flex:2;min-width:200px">
        <input type="password" data-f="apiKey" placeholder="api key (empty if none)" style="flex:1;min-width:120px">
        <input type="text" data-f="defaultModel" placeholder="default model (empty = first listed)" style="flex:1;min-width:140px">
        <button class="bbtn bbtn-primary" data-act="add">add</button>
      </div>
      <p class="meta" style="margin:8px 0 0">Changes apply to the <em>next</em> task immediately (00-tea re-reads
      <code>inference.json</code>). A backend is only usable <em>inside the agents</em> after it is baked into the
      images — <code>./setup.sh --rebuild</code> — until then it shows a <strong>not baked</strong> badge.</p>
    </div>
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <strong>agents</strong>
        <span class="meta">images: ${CFG.images.pi} · ${CFG.images.opencode}</span>
      </div>
      <table style="width:100%;margin-top:8px;border-collapse:collapse">
        <tr><th style="text-align:left">agent</th><th style="text-align:left">model config</th><th style="text-align:left">default</th></tr>
        <tr><td>pi</td><td>models.json (baked)</td><td>${piDef ? `<code>${piDef.provider}/${piDef.id}</code>` : '—'}</td></tr>
        <tr><td>opencode</td><td>opencode.json (baked)</td><td><code>${first.id}/${firstModels[0]?.id ?? '—'}</code></td></tr>
      </table>
    </div>`,
    script: `
    <script>
    const val = (f, k) => f.querySelector('[data-f=' + k + ']').value.trim();
    const post = async (path, opts) => {
      const r = await fetch(path, { method: opts?.method || 'POST', headers: { 'content-type': 'application/json' }, body: opts?.body ? JSON.stringify(opts.body) : undefined });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(j.error || ('request failed: ' + r.status)); return false; }
      return true;
    };
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act, id = btn.dataset.id;
      if (act === 'add') {
        const f = document.getElementById('add-form'); // fresh: live swap may have replaced it
        if (await post('/api/backends', { body: { id: val(f,'id'), url: val(f,'url'), apiKey: val(f,'apiKey'), defaultModel: val(f,'defaultModel') } })) location.reload();
      } else if (act === 'up' || act === 'down') {
        if (await post('/api/backends/' + encodeURIComponent(id) + '/' + act)) location.reload();
      } else if (act === 'del') {
        if (confirm('remove backend ' + id + '?')) { if (await fetch('/api/backends/' + encodeURIComponent(id), { method: 'DELETE' }).then(r => r.ok)) location.reload(); }
      } else if (act === 'edit') {
        const el = document.getElementById('edit-' + id);
        el.style.display = el.style.display === 'flex' ? 'none' : 'flex';
      } else if (act === 'cancel') {
        document.getElementById('edit-' + id).style.display = 'none';
      } else if (act === 'save') {
        const f = document.getElementById('edit-' + id);
        if (await post('/api/backends/' + encodeURIComponent(id), { method: 'PATCH', body: { url: val(f,'url'), apiKey: val(f,'apiKey'), defaultModel: val(f,'defaultModel') } })) location.reload();
      }
    });
    </script>`,
  };
}
