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

  const row = (b, ms, i) => {
    const modelsHtml = ms
      ? ms.map((m) => `<li>${m.id}
          ${m.loaded ? '<span class="badge badge-success">loaded</span>' : m.reportsLoad ? '<span class="meta">idle</span>' : ''}
          ${b.defaultModel === m.id ? '<span class="meta">★ default</span>' : ''}</li>`).join('')
      : '<li class="meta">unreachable</li>';
    const notBaked = !baked.includes(b.id);
    return `<div class="card" id="backend-${b.id}">
      <div class="l1">
        ${b.id}
        <span class="meta">priority ${b.priority}</span>
        ${b.id === piDef?.provider && b.defaultModel === piDef.id ? '<span class="badge badge-success">★ pi default</span>' : ''}
        ${b.apiKey ? '<span class="badge badge-info">keyed</span>' : ''}
        ${notBaked ? '<span class="badge badge-warn" title="not in the baked agent images — run ./setup.sh --rebuild; until then tasks cannot use this backend">not baked</span>' : ''}
        <span style="flex:1"></span>
        <button class="btn" data-act="up" data-id="${b.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn" data-act="down" data-id="${b.id}" ${i === backends.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn" data-act="edit" data-id="${b.id}">edit</button>
        <button class="btn danger" data-act="del" data-id="${b.id}" ${backends.length <= 1 ? 'disabled' : ''} title="remove">✕</button>
      </div>
      <div class="l2">${b.url}</div>
      <div class="bform edit-form" id="edit-${b.id}" style="display:none">
        <input type="text" data-f="url" value="${b.url}" style="flex:2;min-width:200px" placeholder="url">
        <input type="password" data-f="apiKey" value="${b.apiKey}" style="flex:1;min-width:120px" placeholder="api key (empty = none)">
        <input type="text" data-f="defaultModel" value="${b.defaultModel ?? ''}" style="flex:1;min-width:140px" placeholder="default model (empty = auto)">
        <button class="btn primary" data-act="save" data-id="${b.id}">save</button>
        <button class="btn" data-act="cancel" data-id="${b.id}">cancel</button>
      </div>
      <details style="margin-top:8px"><summary class="meta" style="cursor:pointer">${ms ? `${ms.length} models` : 'models'}</summary>
        <ul class="bmodels">${modelsHtml}</ul>
      </details>
    </div>`;
  };

  return {
    html: `
    <style>
    .bform{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
    .bform input{background:var(--color-input-background,#0c0c0c);border:1px solid var(--color-input-border,#333);border-radius:var(--radius-sm);color:var(--color-input-text,#ddd);padding:7px 10px;font-size:13px}
    .bform input:focus{outline:none;border-color:var(--color-primary,#7ab)}
    .bmodels{margin:8px 0 0 18px;padding:0;list-style:none}
    .btable{width:100%;margin-top:8px;border-collapse:collapse}
    .btable th,.btable td{text-align:left;padding:5px 8px;border-top:1px solid var(--color-light-border,#2a2a2a);font-size:13px}
    /* small screens: stack the forms, full-width inputs */
    @media (max-width:720px){
      .bform{flex-direction:column;align-items:stretch}
      .bform input{width:100%;min-width:0}
      .bform .btn{width:100%}
      .l1 .meta{flex-basis:100%;order:9;word-break:break-all}
    }
    </style>
    <h2>selection</h2>
    <div class="card">
      <div class="l1">next task will use <code>${picked.provider}/${picked.id}</code></div>
      <div class="l2">${picked.source}</div>
    </div>

    <h2>backends</h2>
    ${backends.map((b, i) => row(b, models[i], i)).join('')}

    <h2>add a backend</h2>
    <div class="card">
      <div class="l2" style="margin-top:0">any OpenAI-compatible /v1 endpoint — local llama.cpp, vLLM, Ollama, OpenRouter, …</div>
      <div class="bform" id="add-form">
        <input type="text" data-f="id" placeholder="id (e.g. openrouter)" style="flex:1;min-width:120px">
        <input type="text" data-f="url" placeholder="url (e.g. https://openrouter.ai/api)" style="flex:2;min-width:200px">
        <input type="password" data-f="apiKey" placeholder="api key (empty if none)" style="flex:1;min-width:120px">
        <input type="text" data-f="defaultModel" placeholder="default model (empty = first listed)" style="flex:1;min-width:140px">
        <button class="btn primary" data-act="add">add</button>
      </div>
      <div class="l2">Changes apply to the <em>next</em> task immediately (00-tea re-reads <code>inference.json</code>).
      A backend is only usable <em>inside the agents</em> after it is baked into the images —
      <code>./setup.sh --rebuild</code> — until then it shows a <span class="badge badge-warn">not baked</span> badge.</div>
    </div>

    <h2>agents</h2>
    <div class="card">
      <div class="l2" style="margin-top:0">images: ${CFG.images.pi} · ${CFG.images.opencode} — model lists are baked from <code>inference.json</code> at build time</div>
      <table class="btable">
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
