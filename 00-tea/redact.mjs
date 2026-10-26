// Secret redaction for logs. Agents echo env vars in their bash tool calls
// (e.g. `export AGENT_TOKEN=…`), and the task/chat log pipelines write raw
// lines — this scrubs every secret 00-tea itself holds before any line hits
// a log file, the replay buffer, or an SSE client. Applied at the two
// choke points: say() in tasks.mjs and chatSay/chatLive in chat.mjs.
import { CFG } from './config.mjs';
import { readRegistry } from './inference.mjs';

let cache = null;
let at = 0;
const TTL = 30_000; // registry/env changes are rare; no need to rescan per line

const collect = () => {
  const vals = new Set([
    CFG.secret,          // webhook secret
    CFG.adminToken,      // admin token (actions API, UI)
    CFG.chatToken,       // /chat UI gate
    CFG.uiToken,         // whole-UI gate
    CFG.chatGiteaToken,  // chat user's Gitea token
    ...Object.values(CFG.agents).map((a) => a.token),   // per-agent write tokens
    CFG.review.token,    // review user read token (reviewer clone)
    CFG.review.postToken,// review user write token (00-tea posts verdicts)
  ]);
  for (const b of readRegistry()) if (b.apiKey) vals.add(b.apiKey);
  // longest first so a value that is a prefix of another is scrubbed whole
  return [...vals].filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
};

export const redact = (s) => {
  if (typeof s !== 'string' || !s) return s;
  const now = Date.now();
  if (!cache || now - at > TTL) { cache = collect(); at = now; }
  let out = s;
  for (const v of cache)
    if (out.includes(v)) out = out.split(v).join('***');
  return out;
};
