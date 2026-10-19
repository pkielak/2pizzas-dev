#!/usr/bin/env node
// Streaming log filter for `opencode run --format json` output.
// Same reason for existence as output_filter.mjs (the pi one): jq buffers
// piped stdout until the process exits, so logs would arrive in one lump.
// This reads stdin line by line and writes each match immediately, so
// 00-tea's log (and the SSE live view) stream line by line.
//
// Event set (opencode run --format json): step_start, tool_use, text,
// step_finish, error. Only the interesting ones are rendered.
//
// Usage accounting: the LAST step_finish's tokens.total is the peak context
// plus final output — comparable to pi's message_end usage.totalTokens
// (each assistant message's usage already covers the whole context).
let buf = '';
let lastTokens = null;
let failed = false;
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line) continue;
    let out = '';
    try {
      const j = JSON.parse(line);
      if (j.type === 'tool_use') {
        const p = j.part ?? {};
        const status = p.state?.status ?? 'completed';
        out = status === 'completed'
          ? `\n  \u25b8 ${p.tool ?? 'tool'}${p.state?.title ? ` ${p.state.title}` : ''}\n`
          : `\n  \u2717 ${p.tool ?? 'tool'} ${status}\n`;
      } else if (j.type === 'text') {
        out = `${j.part?.text ?? ''}\n`;
      } else if (j.type === 'step_finish') {
        lastTokens = j.part?.tokens?.total ?? null;
      } else if (j.type === 'error') {
        failed = true;
        out = `\n[opencode] ERROR: ${j.error?.data?.message ?? j.error?.name ?? 'unknown error'}\n`;
      }
    } catch { /* not JSON — ignore */ }
    if (out) process.stdout.write(out);
  }
});
process.stdin.on('end', () => {
  // final usage marker — parsed by 00-tea into the task row (UI shows ctx usage)
  if (!failed && lastTokens != null) {
    process.stdout.write(`\n[00-tea] usage: model=${process.env.OPENCODE_MODEL ?? 'unknown'} tokens=${lastTokens}\n`);
  }
  process.exit(0);
});
