#!/usr/bin/env node
// Streaming log filter for `pi -p --mode json` output (replaces the old
// output_filter.jq). jq buffers its output when stdout is a pipe — logs
// arrived in one lump when the agent finished. This reads stdin line by
// line and writes each match immediately, so 2pizzas's log (and the SSE
// live view) stream line by line.
let buf = '';
let lastMsg = null; // last assistant message (carries final usage + model)
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
      if (j.type == null) continue;
      if (j.type === 'message_update') {
        const e = j.assistantMessageEvent;
        if (e.type === 'text_delta') out = e.delta ?? '';
        else if (e.type === 'thinking_start') out = '\n  \u2514 thinking\n';
        else if (e.type === 'toolcall_start' && typeof e.toolName === 'string')
          out = `\n  \u2514 ${e.toolName}\n`;
      } else if (j.type === 'tool_execution_start') {
        const cmd = j.args?.command;
        out = `\n  \u25b8 ${j.toolName} ${cmd ? (cmd.length > 60 ? cmd.slice(0, 60) + '\u2026' : cmd) : ''}\n`;
      } else if (j.type === 'tool_execution_end' && j.isError === true) {
        out = `\n  \u2717 ${j.toolName ?? 'tool'} failed\n`;
      } else if (j.type === 'message_end' && j.message?.role === 'assistant') {
        lastMsg = j.message;
      }
    } catch { /* not JSON — ignore */ }
    if (out) process.stdout.write(out);
  }
});
process.stdin.on('end', () => {
  // final usage marker — parsed by 2pizzas into the task row (UI shows ctx usage)
  const u = lastMsg?.usage;
  if (u && u.totalTokens != null) {
    process.stdout.write(`\n[2pizzas] usage: model=${lastMsg.model ?? 'unknown'} tokens=${u.totalTokens}\n`);
  }
  process.exit(0);
});
