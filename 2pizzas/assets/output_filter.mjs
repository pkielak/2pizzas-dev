#!/usr/bin/env node
// Streaming log filter for `pi -p --mode json` output (replaces the old
// output_filter.jq). jq buffers its output when stdout is a pipe — logs
// arrived in one lump when the agent finished. This reads stdin line by
// line and writes each match immediately, so 2pizzas's log (and the SSE
// live view) stream line by line.
//
// The output is the SAME compact transcript events the chat view uses
// (piLine in chat.mjs), so a task log IS a parseable transcript:
//   settled (persisted + parsed by the UI's parseLine):
//     text_block, tool_call, gitea_ref, settle, compacted, error
//   live-only (drive the UI's live block stream, skipped on settled parse):
//     working, text_delta, thinking_delta, tool_end, auto_retry
// The `[2pizzas] usage:` marker lines are kept — 2pizzas stores the LAST
// one it sees as the task's token total, and the UI's live tail shows it.
let buf = '';
let lastMsg = null; // last assistant message (carries final usage + model)
let lastTool = null; // full command — gitea_ref detection needs the flags
const GITEA_REF_RE = /https?:\/\/[^\s"'<>\\]+?\/(issues|pulls)\/(\d+)/;

const emit = (ev) =>
  process.stdout.write((typeof ev === 'string' ? ev : JSON.stringify(ev)) + '\n');

// emit the same `[2pizzas] usage:` marker after every assistant turn so the
// UI's live tail can show a token count that updates DURING the run (2pizzas
// stores the LAST one it sees, which equals the final total)
const emitUsage = (msg) => {
  const u = msg?.usage;
  if (u && u.totalTokens != null)
    emit(`[2pizzas] usage: model=${msg.model ?? 'unknown'} tokens=${u.totalTokens}`);
};

// the agent creates Gitea issues/PRs with curl (POST/--data); the API
// response carries the created object's html_url (…/issues/42,
// …/pulls/42). Detect a write whose output contains such a URL and turn
// it into a gitea_ref transcript event — the web UI renders it as a link.
// Same rules as giteaRefFromTool() in chat.mjs.
const giteaRefFromTool = (tool, e) => {
  if (!tool || tool.name !== 'bash' || e.isError) return null;
  const cmd = tool.command || '';
  if (!/\bcurl\b/.test(cmd)) return null;
  if (!/-X\s*(POST|PUT|PATCH)\b|(^|\s)(-d|-F|--data|--form)\b/.test(cmd)) return null;
  const r = e.result || {};
  const out = (typeof r.output === 'string' && r.output)
    || (Array.isArray(r.content) && r.content.map((p) => p.text || '').join(''))
    || '';
  const m = GITEA_REF_RE.exec(out);
  return m ? { type: 'gitea_ref', kind: m[1] === 'pulls' ? 'pr' : 'issue', number: +m[2], url: m[0] } : null;
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
      case 'agent_start':
        emit({ type: 'working' });
        break;
      case 'agent_settled':
        emit({ type: 'settle' });
        break;
      case 'compaction_end':
        if (e.errorMessage) emit({ type: 'error', message: `compaction failed: ${e.errorMessage}` });
        else emit({ type: 'compacted', reason: e.reason });
        break;
      case 'message_update': {
        const d = e.assistantMessageEvent || {};
        if (d.type === 'text_delta') emit({ type: 'text_delta', delta: d.delta });
        else if (d.type === 'thinking_delta') emit({ type: 'thinking_delta', delta: d.delta });
        break;
      }
      case 'message_end': {
        const m = e.message || {};
        if (m.role !== 'assistant') break; // user echo, toolResult
        lastMsg = m;
        // the assistant block is settled — all its text parts concatenated
        const text = (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
        if (text.trim()) emit({ type: 'text_block', text });
        emitUsage(m);
        break;
      }
      case 'tool_execution_start':
        lastTool = { name: e.toolName, command: e.args && e.args.command ? String(e.args.command) : '' };
        emit({ type: 'tool_call', name: e.toolName,
          arg: String(e.args && (e.args.command || JSON.stringify(e.args))).slice(0, 500) });
        break;
      case 'tool_execution_end': {
        const ref = giteaRefFromTool(lastTool, e);
        lastTool = null;
        if (ref) emit(ref);
        emit({ type: 'tool_end' });
        break;
      }
      case 'auto_retry_start':
        emit({ type: 'auto_retry', attempt: e.attempt, max: e.maxAttempts });
        break;
    }
  }
});
process.stdin.on('end', () => {
  // final usage marker — parsed by 2pizzas into the task row (UI shows ctx usage)
  // (equals the last per-turn live line, kept so a bare stream still records it)
  emitUsage(lastMsg);
  process.exit(0);
});
