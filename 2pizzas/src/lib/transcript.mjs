import { parseLegacyLine } from './hl.mjs';

// Shared transcript-block accumulation — extracted from the chat view's
// handle() so the task view can live-stream its log the SAME way. Both
// views feed raw transcript lines (compact JSON events + [2pizzas]
// markers) into pushTranscriptLine(), which appends/accumulates block
// objects for TranscriptBlocks.svelte identically:
//   settled events (user_message, text_block, tool_call, gitea_ref, settle,
//   compacted, error) → blocks (replayed on reconnect — they rebuild the
//   transcript in lockstep)
//   live-only events (text_delta, thinking_delta, working, tool_end,
//   auto_retry, compaction, ctx) → status line + incremental
//   text/thinking blocks (never rendered on the settled parse)
//
// `blocks` must be the view's $state array (the reducer mutates it in
// place — pushes blocks, appends to un-settled text/thinking blocks,
// flips settled). hooks: onStatus(s) — the .mstatus line;
// onUsage(model, tokens) — the filter's `[2pizzas] usage:` marker;
// onCtx(tokens, window) — pi's context-usage report.

const curUnsettled = (blocks, kind) => {
  const last = blocks[blocks.length - 1];
  return last && last.kind === kind && !last.settled ? last : null;
};

export const pushTranscriptLine = (blocks, line, hooks = {}) => {
  const onStatus = hooks.onStatus ?? (() => {});
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    // non-JSON line: [2pizzas] markers, plus (for task logs written by the
    // pre-transcript filters) plain console lines — rendered as dim console
    // blocks, the SAME way the settled parse (parseTaskLine) renders them
    if (typeof line !== 'string' || !line.trim()) return;
    if (line.startsWith('[2pizzas]')) {
      const m = /^\[2pizzas\] usage: model=(\S+) tokens=(\d+)/.exec(line);
      if (m) hooks.onUsage?.(m[1], +m[2]); // live token readout — no block
      else blocks.push({ kind: 'settle', text: line });
      return;
    }
    // plain line: the SETTLED parse maps old-format (pre-transcript) task
    // logs through parseLegacyLine, where plain text IS the agent's output.
    // The LIVE path never sees old logs (a running task's filter writes
    // JSON events) — a plain line here is server noise (chat's `[stderr]`
    // lines, which the old chat handler dropped) → dim console block, not
    // an agent utterance
    const b = parseLegacyLine(line);
    if (!b) return;
    const blk = b.kind === 'text' ? { kind: 'console', text: b.text } : b;
    if (blk.kind === 'console') {
      // consecutive console lines merge into one block
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'console') { last.text += '\n' + blk.text; return; }
    }
    blocks.push(blk);
    return;
  }
  // the delta-built (un-settled) THINKING block, if the last block is one —
  // finalized the moment the next phase (text/tool/settle) starts
  const settleThinking = () => {
    const t = curUnsettled(blocks, 'thinking');
    if (t) t.settled = true;
  };
  switch (e.type) {
    case 'user_message':
      blocks.push({ kind: 'user', text: e.message });
      break;
    case 'text_delta': {
      settleThinking();
      // the delta-built (un-settled) text block, if the last block is one
      let t = curUnsettled(blocks, 'text');
      if (!t) {
        if (!e.delta || !e.delta.trim()) return; // don't start a block for whitespace-only deltas
        t = { kind: 'text', text: '', settled: false };
        blocks.push(t);
      }
      t.text += e.delta;
      onStatus('writing…');
      break;
    }
    case 'text_block':
      // settled block: finalize the delta-built block (same text — a visual
      // no-op) and mark it settled so the next live delta starts a FRESH
      // block; replay clients get it whole
      settleThinking();
      let t = curUnsettled(blocks, 'text');
      if (!t) t = { kind: 'text', text: '', settled: false };
      t.text = e.text;
      t.settled = true;
      break;
    case 'gitea_ref':
      blocks.push({ kind: 'ref', refKind: e.kind, number: e.number, url: e.url });
      break;
    case 'tool_call':
      settleThinking();
      blocks.push({ kind: 'tool', name: e.name, arg: String(e.arg).slice(0, 200) });
      onStatus(`running ${e.name}…`);
      break;
    case 'tool_end':
      onStatus('thinking…');
      break;
    case 'thinking_delta': {
      let t = curUnsettled(blocks, 'thinking');
      if (!t) {
        if (!e.delta || !e.delta.trim()) return; // don't start a block for whitespace-only deltas
        t = { kind: 'thinking', text: '', settled: false };
        blocks.push(t);
      }
      t.text += e.delta;
      onStatus('thinking…');
      break;
    }
    case 'working':
      onStatus('working…');
      break;
    case 'settle':
      onStatus('');
      settleThinking();
      blocks.push({ kind: 'settle', text: 'settled' });
      break;
    case 'auto_retry':
      onStatus(`retrying (${e.attempt}/${e.max})…`);
      break;
    case 'compaction':
      onStatus('compacting context…');
      break;
    case 'compacted':
      blocks.push({ kind: 'compacted' });
      break;
    case 'ctx':
      hooks.onCtx?.(e.tokens, e.window);
      break;
    case 'error':
      onStatus('');
      blocks.push({ kind: 'error', message: e.message });
      break;
  }
};
