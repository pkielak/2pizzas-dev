// Ported from the old server-side renderers (ui/chat.mjs, layout.mjs):
// host-command chips, Gitea ref links, and transcript-line parsing.

// re-point Gitea issue/PR URLs at THIS host (the agent sees container-
// internal hostnames; the browser needs the operator's)
const GITEA_RE = /^https?:\/\/[^/]+(\/[^#?]*?(?:\/issues|\/pulls)\/\d+)/;
export const giteaHref = (u) => {
  const m = GITEA_RE.exec(u || '');
  return m ? location.protocol + '//' + location.hostname + ':3000' + m[1] : u;
};

// build a gitea URL for a repo path (owner/name) + optional sub-path
export const giteaRepoHref = (repo, suffix = '') =>
  location.protocol + '//' + location.hostname + ':3000/' + repo + (suffix ? '/' + suffix : '');

// raw text → escaped HTML with host commands as chips and Gitea issue/PR
// URLs as links (same rules as the old server renderer)
export const hlText = (raw) => {
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  raw = String(raw).replace(/\n{3,}/g, '\n\n'); // collapse excessive blank lines
  let out = '', last = 0;
  for (const m of raw.matchAll(/\.\/(setup\.sh\s+\S+|deploy\.sh)|https?:\/\/[^\s"'<>]+?\/(issues|pulls)\/\d+/g)) {
    out += esc(raw.slice(last, m.index));
    out += m[0].startsWith('./')
      ? `<code class="cmdchip">${esc(m[1])}</code>`
      : `<a class="glref" href="${esc(giteaHref(m[0]))}" target="_blank" rel="noopener">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(raw.slice(last));
};

// console/log line → escaped HTML; the pi filter's thinking-phase marker
// ("  └ thinking") gets a dimmed span so thinking lines read apart from the
// rest of the log
export const hlConsoleLine = (line) => {
  const esc = String(line).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return /^\s*└ thinking\b/.test(line) ? `<span class="think">${esc}</span>` : esc;
};
export const hlConsole = (raw) => String(raw).split('\n').map(hlConsoleLine).join('\n');

// one transcript line (event JSON string or plain marker text) → a block
// object for TranscriptBlocks.svelte. Returns null for live-only events
// (they never reach the persisted log). Tolerates an already-parsed
// object (defensive — the /history API and the SSE stream both send raw
// strings; a format drift must not silently blank the transcript).
export const parseLine = (line) => {
  if (typeof line !== 'string') line = JSON.stringify(line);
  let e;
  try { e = JSON.parse(line); }
  catch { return typeof line === 'string' && line.startsWith('[2pizzas]') ? { kind: 'settle', text: line } : null; }
  switch (e.type) {
    case 'user_message': return { kind: 'user', text: e.message };
    case 'text_block': return { kind: 'text', text: e.text, settled: true };
    case 'tool_call': return { kind: 'tool', name: e.name, arg: String(e.arg).slice(0, 200) };
    case 'gitea_ref': return { kind: 'ref', refKind: e.kind, number: e.number, url: e.url };
    case 'settle': return { kind: 'settle', text: 'settled' };
    case 'compacted': return { kind: 'compacted' };
    case 'error': return { kind: 'error', message: e.message };
    default: return null;
  }
};
