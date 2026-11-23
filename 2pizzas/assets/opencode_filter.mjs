#!/usr/bin/env node
// Streaming log filter for `opencode run --format json` output.
// Same reason for existence as output_filter.mjs (the pi one): jq buffers
// piped stdout until the process exits, so logs would arrive in one lump.
// This reads stdin line by line and writes each match immediately, so
// 2pizzas's log (and the SSE live view) stream line by line.
//
// The output is the SAME compact transcript events the chat view uses
// (piLine in chat.mjs), so a task log IS a parseable transcript:
//   settled (persisted + parsed by the UI's parseLine):
//     text_block, tool_call, settle, error
//   live-only (drive the UI's live block stream, skipped on settled parse):
//     working
// The `[2pizzas] usage:` marker lines are kept — 2pizzas stores the LAST
// one it sees as the task's token total, and the UI's live tail shows it.
//
// Event set (opencode run --format json): step_start, tool_use, text,
// step_finish, error.
//
// Usage accounting: the LAST step_finish's tokens.total is the peak context
// plus final output — comparable to pi's message_end usage.totalTokens
// (each assistant message's usage already covers the whole context).
let buf = '';
let lastTokens = null;
let failed = false;
const emit = (ev) =>
  process.stdout.write((typeof ev === 'string' ? ev : JSON.stringify(ev)) + '\n');
// emit a live `[2pizzas] usage:` marker on every step_finish so the UI's
// live tail shows a token count that climbs as the run progresses (2pizzas
// stores the LAST one it sees, which equals the final total)
const emitUsage = (t) => {
  if (t != null) emit(`[2pizzas] usage: model=${process.env.OPENCODE_MODEL ?? 'unknown'} tokens=${t}`);
};
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // not JSON — ignore
    switch (e.type) {
      case 'step_start':
        emit({ type: 'working' });
        break;
      case 'tool_use': {
        const p = e.part ?? {};
        const status = p.state?.status ?? 'completed';
        if (status === 'completed')
          emit({ type: 'tool_call', name: p.tool ?? 'tool', arg: String(p.state?.title ?? '').slice(0, 500) });
        else
          emit({ type: 'error', message: `${p.tool ?? 'tool'}: ${status}` });
        break;
      }
      case 'text':
        // the part's full text (opencode does not stream deltas) — a settled block
        {
          const text = e.part?.text ?? '';
          if (text.trim()) emit({ type: 'text_block', text });
        }
        break;
      case 'step_finish':
        lastTokens = e.part?.tokens?.total ?? null;
        emitUsage(lastTokens);
        break;
      case 'error':
        failed = true;
        emit({ type: 'error', message: e.error?.data?.message ?? e.error?.name ?? 'unknown error' });
        break;
    }
  }
});
process.stdin.on('end', () => {
  // single settle at run end — opencode has no per-step "agent settled"
  // event (the bootstrap's clean-exit check runs on the RAW stream, not
  // this filtered one)
  if (!failed) emit({ type: 'settle' });
  // final usage marker — parsed by 2pizzas into the task row (UI shows ctx usage)
  if (!failed && lastTokens != null) emitUsage(lastTokens);
  process.exit(0);
});
