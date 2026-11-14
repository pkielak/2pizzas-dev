export const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));

// context used / window, e.g. "37.2k/65k tok (57%)" — '' when unknown
export const ctxText = (t) => {
  if (t.tokens == null || !t.model_ctx) return '';
  const pct = Math.min(100, Math.round((t.tokens / t.model_ctx) * 100));
  return `${fmtTok(t.tokens)}/${fmtTok(t.model_ctx)} tok (${pct}%)`;
};
