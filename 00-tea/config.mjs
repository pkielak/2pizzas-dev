// 00-tea configuration — everything is env-injected by docker-compose (.env).
export const CFG = {
  port: +(process.env.PORT || 3001),
  dataDir: process.env.DATA_DIR || '/data',
  secret: process.env.WEBHOOK_SECRET || '',
  // Per-agent Gitea identities: each work agent is its OWN user (native
  // @mention autocomplete + per-agent commit/PR attribution). The review
  // user carries TWO tokens: a read one (the reviewer container clones
  // with it — it physically cannot push) and a write one held by 00-tea
  // ONLY (it posts the review verdicts). The legacy single "bot" user is
  // dormant on old instances; fresh instances never create it.
  agents: {
    pi: { login: 'pi', email: 'pi@localhost', token: process.env.PI_TOKEN || '' },
    opencode: { login: 'opencode', email: 'opencode@localhost', token: process.env.OPENCODE_TOKEN || '' },
    infra: { login: 'infra', email: 'infra@localhost', token: process.env.INFRA_TOKEN || '' },
  },
  review: {
    login: 'review',
    email: 'review@localhost',
    token: process.env.REVIEW_TOKEN || '',        // read:repository — reviewer clone
    postToken: process.env.REVIEW_POST_TOKEN || '', // write — 00-tea posts verdicts as review
  },
  giteaApi: process.env.GITEA_API || 'http://gitea:3000/api/v1', // reachable from THIS container
  giteaHost: process.env.GITEA_HOST || 'host.docker.internal:3000', // reachable from JOB containers
  // seed list of managed repos — self-enrolling (an @agent mention on an
  // unmanaged repo persists it in managed_repos and grants the bot write
  // access) makes this a convenience, not a gate
  repos: (process.env.AGENTD_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean),
   images: {
    pi: process.env.AGENT_IMAGE_PI || 'agent-sandbox:pi',
    opencode: process.env.AGENT_IMAGE_OPENCODE || 'agent-sandbox:opencode',
    review: process.env.AGENT_IMAGE_REVIEW || 'agent-sandbox:review',
    infra: process.env.AGENT_IMAGE_INFRA || 'agent-sandbox:infra',
  },
  reviewMaxRounds: +(process.env.REVIEW_MAX_ROUNDS || 3),
  // @infra agent: repairs the stack itself. The only agent that runs on runc
  // with the host docker socket + the infra repo bind-mounted (see tasks.mjs).
  // Auto-enqueued on infra-class failures (cooldown: one incident per window);
  // @infra on the infra repo works it manually.
  infraRepo: process.env.INFRA_REPO || 'owner/gitea-with-agents',
  infraHostRepo: process.env.INFRA_HOST_REPO || '', // host path of the infra repo
  infraCooldownMs: +(process.env.INFRA_COOLDOWN_MINUTES || 15) * 60_000,
  // legacy sender — old instances have comments/commits by the dormant
  // "bot" user; keep it on the no-self-react list (fresh instances: no such user)
  botLogin: 'bot',
  themeUser: process.env.AGENTD_THEME_USER || 'admin',   // whose Gitea theme the UI mirrors
  giteaContainer: process.env.GITEA_CONTAINER || 'gitea',  // theme asset discovery (docker exec grep on the binary)
  giteaDbContainer: process.env.GITEA_DB_CONTAINER || 'gitea-db-1',
  giteaDbUser: process.env.GITEA_DB_USER || 'postgres',
  giteaDbName: process.env.GITEA_DB_NAME || 'gitea',
  adminToken: process.env.ADMIN_TOKEN || '', // admin-scope token — actions runs API
  pagesSites: (process.env.PAGES_SITES || '').split(',').map((s) => s.trim()).filter(Boolean),
  chatToken: process.env.CHAT_TOKEN || '',   // optional gate for /chat + /api/chat* (UI is tailnet-reachable)
  uiToken: process.env.UI_TOKEN || '',       // gate for the WHOLE 00-tea UI (falls back to CHAT_TOKEN)
  // /chat agents act as the separate "chat" Gitea user (audit separation from
  // task work): the token goes into the chat containers; per-repo WRITE
  // access is still gated by collaborator grants (managed from the /chat UI)
  chatGiteaToken: process.env.CHAT_GITEA_TOKEN || '',
  chatLogin: process.env.CHAT_LOGIN || 'chat',
  chatIdleMs: +(process.env.CHAT_IDLE_MINUTES || 30) * 60_000,  // kill idle chat containers
  chatNetwork: process.env.CHAT_NETWORK || 'gitea_gitea',  // chat containers join it (reached by name)
  // resource caps for the long-lived, user-spawned chat containers — inference
  // runs on the host's llama.cpp, so the container only needs room for node +
  // git clones + light builds; without caps a runaway chat process is a host DoS
  chatMemory: process.env.CHAT_MEMORY || '4g',
  chatCpus: process.env.CHAT_CPUS || '2',
  // cap for the one-shot agent JOB containers (task pump runs 1 concurrent) —
  // keeps the host cores reserved for llama.cpp (see setup.sh CPU plan)
  agentCpus: process.env.AGENT_CPUS || '2',
  pollIntervalMs: 60_000,
  concurrency: 1,
  // inference backend registry (repo-root file, mounted ro) — see inference.mjs
  inferenceFile: process.env.INFERENCE_FILE || '/app/inference.json',
  // legacy single-backend fallback when inference.json is absent
  llamaUrl: (process.env.LLAMA_CPP_URL || 'http://localhost:8080').replace(/\/+$/, ''),
};

export const MARKER = '<!-- via:agent -->';
export const MENTIONS = [
  { agent: 'pi', re: /@pi\b/ },
  { agent: 'opencode', re: /@opencode\b/ },
  { agent: 'infra', re: /@infra\b/ },
];
