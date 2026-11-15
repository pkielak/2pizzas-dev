export const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));

// android CI run status → {cls, text} badge — shared by home + android pages
export const runPill = (r) => {
  if (['queued', 'waiting', 'pending', 'running'].includes(r.status)) return { cls: 'running', text: r.status };
  if (r.conclusion === 'success') return { cls: 'success', text: 'success' };
  if (r.conclusion === 'failure') return { cls: 'failure', text: 'failure' };
  if (r.conclusion === 'cancelled') return { cls: 'queued', text: 'cancelled' };
  return { cls: 'queued', text: r.status || '—' };
};

// context used / window, e.g. "37.2k/65k tok (57%)" — '' when unknown
export const ctxText = (t) => {
  if (t.tokens == null || !t.model_ctx) return '';
  const pct = Math.min(100, Math.round((t.tokens / t.model_ctx) * 100));
  return `${fmtTok(t.tokens)}/${fmtTok(t.model_ctx)} tok (${pct}%)`;
};
