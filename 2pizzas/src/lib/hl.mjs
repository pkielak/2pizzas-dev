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

// OLD task logs are plain console text (the pre-transcript filter format).
// The agent-relevant lines map onto the SAME block kinds the transcript
// uses — agent text renders as .mtext exactly like the chat, thinking as
// the collapsible .mthinking (the old filters dropped the thinking text,
// so its body is empty), tools as .mtool — leaving only the `$ …`
// bootstrap noise as a dim `console` block. [2pizzas] / [opencode]
// markers are handled by the callers.
export const parseLegacyLine = (line) => {
  const t = String(line);
  if (t.startsWith('[2pizzas]')) return null;
  const tool = /^  ▸ (\S+)\s*(.*)$/.exec(t);
  if (tool) return { kind: 'tool', name: tool[1], arg: tool[2].slice(0, 200) };
  if (/^  └ thinking\s*$/.test(t)) return { kind: 'thinking', text: '', settled: true };
  // old pi filter's toolcall_start line: `  └ <toolName>`
  const tstart = /^  └ (\S+)\s*$/.exec(t);
  if (tstart) return { kind: 'tool', name: tstart[1], arg: '' };
  const failed = /^  ✗ (.+)$/.exec(t);
  if (failed) return { kind: 'error', message: failed[1] };
  const oe = /^\[opencode\] ERROR:\s*(.*)$/.exec(t);
  if (oe) return { kind: 'error', message: oe[1] };
  if (t.startsWith('$ ')) return { kind: 'console', text: t };
  if (t.trim()) return { kind: 'text', text: t, settled: true };
  return null;
};

// parseLine + task-log fallback. Lines that DO parse as JSON are live-only
// events (text_delta, working, tool_end, …) — the settled view never
// renders them (the settled text_block carries the text). Unparseable
// lines are old-format console text — parseLegacyLine maps them onto the
// chat block kinds. A few [2pizzas] markers get a better home than the
// generic settle block: the usage marker is carried by the ctx footer,
// and an ERROR marker is an error block.
export const parseTaskLine = (line) => {
  const b = parseLine(line);
  if (b) {
    if (b.kind === 'settle' && typeof b.text === 'string') {
      if (b.text.startsWith('[2pizzas] usage:')) return null;
      if (b.text.startsWith('[2pizzas] ERROR:'))
        return { kind: 'error', message: b.text.slice('[2pizzas] ERROR:'.length).trim() };
    }
    return b;
  }
  if (typeof line !== 'string' || !line.trim()) return null;
  try { JSON.parse(line); return null; } // parseable JSON = live-only event
  catch { return parseLegacyLine(line); }
};

// whole old/new task log → blocks; consecutive agent-text lines merge into
// one block (a paragraph is one .mtext, not one per line)
export const parseTaskLog = (log) => {
  const blocks = [];
  for (const line of String(log).split('\n')) {
    const b = parseTaskLine(line);
    if (!b) continue;
    const last = blocks[blocks.length - 1];
    if (b.kind === 'text' && last && last.kind === 'text' && last.settled) {
      last.text += '\n' + b.text;
      continue;
    }
    blocks.push(b);
  }
  return blocks;
};
