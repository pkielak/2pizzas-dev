# AGENTS.md

Instructions for AI agents (pi, opencode, ...) working in this repository.

## What this repo is

Infrastructure-as-code for a local Gitea instance with a webhook-driven AI
agent dispatcher (`2pizzas`). Everything here is live: the running Docker
containers were started from this directory. Changing a file and not
restarting/rebuilding the matching container means the change has no effect.

## How the agent automation works

A `@pi` / `@opencode` mention on an issue or PR in a managed repo becomes an
agent task. The pipeline (replaces the old Gitea-Actions agent workflows):

```
Gitea webhook ──► 2pizzas (sqlite queue) ──► docker run --runtime=runsc agent-sandbox:<agent>
                                              (one-shot, gVisor-sandboxed)
                                              └─► agent works, posts reply via post-comment.sh
```

- **2pizzas** (`2pizzas/server.mjs`, image built from `2pizzas/Dockerfile`) is a
  single Node service. It receives ONE **global (system) Gitea webhook** that
  fires for every repo on the instance (2pizzas gates on managed repos +
  `@agent` mentions; the hook's events must include BOTH `issue_comment` AND
  `pull_request_comment` — comments on a PR fire the latter, not the
  former, so a PR-only mention would never be delivered), dedupes + queues
  tasks in sqlite, and runs each task as
  an ephemeral `docker run --rm --runtime=runsc agent-sandbox:<agent>` container.
- **Deterministic security scanners** (`gitleaks`, `semgrep`) are baked
  into `agent-sandbox:base` (semgrep rule packs baked as local configs in
  `/etc/semgrep` at build time, so the gVisor sandbox needs no egress to the
  registry) and run in two places: the
  `security-scan.yaml` CI workflow (every PR on my-runner: gitleaks over
  history + semgrep `p/secrets` blocking, `auto` advisory) and the reviewer's
  `code-review` skill (scanners first, LLM judgment on top). A committed
  secret / blocking finding is a `fail` concern in the review, not a nitpick.
- **Review chain** (after any work task that pushed commits): 2pizzas
  enqueues an `agent-review` task (internal — never via the webhook) that runs
  `agent-sandbox:review` (opencode + a baked `code-review` skill) on a
  **read-only clone** (`REVIEW_TOKEN`, read scope — the container gets no
  write token, so the reviewer cannot push OR post; 2pizzas posts the review
  comment itself from the `[2pizzas] review-body-*` markers in the task log).
  The review must end with `<!-- review:pass -->` / `<!-- review:fail -->`;
  `fail` enqueues a `rework` task (original agent, concerns as prompt,
  `round+1`) whose push starts the next review round. Capped at
  `REVIEW_MAX_ROUNDS` (default 3) — at the cap a "review cycle exhausted"
  comment is posted and a human takes over. Chain links live in
  `tasks.parent_id` / `tasks.round` / `tasks.pr`; the bootstrap's
  `[2pizzas] ref:` / `[2pizzas] pr:` log lines carry the pushed refs + PR
  number into the chain. Don't drop those marker lines, the review-body
  markers, or the verdict parse in `afterTask()`.
- **Infra agent** (`agent-sandbox:infra`, `@infra` on the infra repo):
  repairs the stack itself. It is the ONLY agent that runs on **runc** with
  the host **docker socket** + the live infra repo bind-mounted read-only
  (`INFRA_HOST_REPO` → `/infra-src`; the bootstrap clones a container-local
  copy, so host `.git` is never touched). `onTaskFailure()` classifies
  failures: infra-class (exit 143/137/130, docker/host errors) → the victim
  is **retried once** (`tasks.retried_of`) AND an `agent-infra` task is
  enqueued on a freshly opened incident issue (one per
  `INFRA_COOLDOWN_MINUTES` window — later failures append to the existing
  issue). Infra tasks never chase themselves. Infra code changes go to a
  branch+PR and are reviewed by the normal chain; ops actions (rebuild,
  `up -d`) it executes directly.
- **Per-agent Gitea identities.** Each work agent is its OWN Gitea user
  (`pi`, `opencode`, `infra`) with a write token (`PI_TOKEN` etc.) —
  native `@` autocomplete in the Gitea UI + per-agent commit/PR/comment
  attribution. The `review` user carries TWO tokens: `REVIEW_TOKEN`
  (read:repository — the reviewer container clones with it and physically
  cannot push) and `REVIEW_POST_TOKEN` (write — held by 2pizzas ONLY, posts
  the review verdicts as `review`). The legacy single `bot` user is dormant
  on old instances (kept for history attribution); fresh instances never
  create it. Managed repos get collaborator grants for all four agent users
  (write: pi/opencode/infra, read: review) — seed.sh for env-listed repos,
  2pizzas at startup + on self-enrollment. `enqueue()` ignores comments by
  any agent user (plus dormant `bot` + `chat`).
- **Inference is backend-agnostic.** The backend registry is
  `inference.json` (repo root, gitignored, mounted ro into 2pizzas;
  `inference.json.example` committed): every backend is an OpenAI-compatible
  `/v1` endpoint (local llama.cpp router, vLLM, Ollama, OpenRouter, …) with
  `id` (the provider ID baked into the agent images), `url`, `apiKey`,
  `priority`, `defaultModel`. `2pizzas/inference.mjs` walks them by priority:
  a backend that **reports load state** (the llama.cpp router) → its default
  if **loaded**, else whatever is **loaded** (lazy-loading a second 27B+
  model fails while one is resident), else the default (lazy-load); a
  backend **without** load state → its default; **unreachable** backends are
  skipped (failover). Tasks/chats get `--model <provider>/<id>`; model is
  stored per task as `provider/id` (so `/stats` splits usage per backend).
  The agent images BAKE the same registry (setup.sh generates
  `pi-settings/models.json` + `opencode.json` from it) — a `--model` missing
  from the baked config fails opaquely inside the agent, so
  `checkBakedSync()` logs a `[2pizzas] WARNING: … run ./setup.sh --rebuild`
  instead. 2pizzas re-reads `inference.json` on change (no restart); the
  images need `./setup.sh --rebuild`. Legacy fallback: without the file,
  single backend from `LLAMA_CPP_URL`. Model + ctx window are stored per
  task; the per-agent JSON stream filter (`output_filter.mjs` /
  `opencode_filter.mjs`) emits a final `[2pizzas] usage: model=… tokens=…`
  line that 2pizzas saves — the UI shows `model · used/window tok (pct)` on
  every task.
- **Webhooks are at-least-once** → deliveries and tasks are deduped on
  `(repo, kind, comment_id)`. A 60s poll fallback (managed repos only) rescues
  any webhook Gitea never delivered.
- **New managed repo = self-enrolling.** An `@agent` mention on an
  unmanaged repo opts it in: 2pizzas persists it in the `managed_repos`
  sqlite table and grants the agent users collaborator access itself
  (write for pi/opencode/infra, read for review — same API calls as seed.sh). No `.env`, no reseed, no restart. `AGENTD_REPOS` is an
  optional seed/pin list (env repos can't be removed from the UI; the ✕ on
  `/repos` only removes self-enrolled ones — `DELETE /api/repos/:owner/:name`).
  The global webhook covers new repos automatically.
- **Loop prevention**: replies are stamped `<!-- via:agent -->` by
  `2pizzas/assets/post-comment.sh`; comments carrying that marker (or authored
  by an agent user) are never enqueued.
- **No-action rule**: agents sometimes finish cleanly without pushing
  anything or replying. The bootstrap therefore verifies after the agent run
  that a visible action happened — remote refs changed (pushed commits, and
  the BEFORE snapshot is taken INSIDE the repo, right after `cd repo` — an
  empty/failed snapshot would diff against the full "after" list and make
  every task a false positive "pushed commits"; the timestamp `>` comparisons
  must keep the operator QUOTED — an unquoted `>` inside `[ ... ]` is an
  output redirection, so `[ A > B ]` is always true for non-empty A), a
  PR by the agent user created since task start, or an agent comment since
  task start —
  and posts `/tmp/reply.md` if it exists (post-comment.sh deletes the file
  after posting, so a surviving file means "not yet posted"). If nothing was
  done, the bootstrap posts a fallback error comment itself and the task is
  marked `failure` (`[2pizzas] no-action` marker). Don't drop the enforcement
  block from the bootstrap or the marker check in `runTask()`.
- **UI / observability**: dashboard at `http://127.0.0.1:3001` — `/` is a home
  page (latest tasks + android builds + pages status), `/infra` a live SVG
  block diagram of the whole stack (Gitea → webhook → 2pizzas → runsc agent
  jobs → llama.cpp, runners, pages, chat — dots from `docker ps`),
  `/tasks` the full task list, `/android` the latest builds on `android-runner` (admin actions-runs
  API via `ADMIN_TOKEN`; a run counts as android iff one of its jobs carries
  the `android` label — the runs API itself doesn't expose labels), `/pages`
  the gh-pages sites (driven by `PAGES_SITES` in `.env`: `repo:port:container`
  per `pages/` service; last deployed commit read via `docker exec git log`),
  plus `/stats` for token/model usage aggregates and `/backends` for the
  inference backends — read AND admin: add/edit/move/delete
  (`POST|PATCH|DELETE /api/backends`, `POST /api/backends/:id/up|down`), plus
  "test"/"test url" buttons that probe reachability FROM 2pizzas's own vantage
  (`GET /api/backends/:id/test`, `POST /api/backends/test` → ok/models/error/
  hint) — the loopback gotcha is the #1 misconfig this catches — edits
  `inference.json` IN PLACE (it is a bind-mounted host file — a rename would
  swap the inode; `writeRegistry()` in inference.mjs must stay
  truncate+write), applies to the next task without a restart; a "not baked"
  badge marks backends missing from the agent images (`GET
  /api/backends/baked`) until `./setup.sh --rebuild`),
  per-task logs in `data-2pizzas/logs/<id>.log`, `GET /api/tasks`. Running
  tasks show a **live log view**: `GET /task/:id/stream` is an SSE tail that
  emits each log line as it hits the file. The whole path is unbuffered:
  pi prints JSON lines live → `output_filter.mjs` (node) writes each match
  immediately → docker pipe → `appendFileSync`. Do NOT "simplify" the filter
  back to jq — jq buffers piped stdout until the process exits.
- **The UI mirrors the configured Gitea theme.** 2pizzas reads the operator's
  theme from the db (`docker exec gitea-db-1 psql …` — Gitea 1.27's user API
  omits the theme field) and the theme→css-file map by grepping the gitea
  binary (content-hashed filenames, ~15s → runs in the background), then
  serves Gitea's theme CSS same-origin at `/assets/gitea-theme.css`. All UI
  colors are Gitea `--color-*` variables with hardcoded dark fallbacks, so it
  degrades gracefully if Gitea is down. Result persists in
  `data-2pizzas/theme.json` (10-min TTL); the first page after a cold start
  renders with the fallback palette for ~15s until discovery finishes.
  Finished tasks show the last 400 lines statically.
- **Agent chat** (`/chat`): live conversations with pi in LONG-LIVED
  runsc containers (the counterpart of the one-shot task containers).
  pi runs `pi --mode rpc` (JSONL over stdin/stdout). The raw pi stream is
  FILTERED server-side (`piLine()` in `chat.mjs`) before it hits the log,
  the replay buffer, and the SSE clients — unfiltered it was every
  text/thinking delta, tool partial results, and `agent_end` carrying the
  FULL message history (57MB logs, a noise-poisoned replay buffer, tens of
  MB per reconnect). Two lanes: `chatSay` = transcript events (user
  messages, settled text blocks, tool calls, settle) → log + replay +
  clients; `chatLive` = transient deltas/status → clients only. The UI's
  `text_block` handler finalizes the delta-built block and marks it
  `settled` so post-reconnect live deltas start a fresh block — don't drop
  the filter or the settled-block semantics. Long-lived chat sessions also
  get auto-compaction enabled at runtime (`set_auto_compaction` RPC command
  — the image bakes it OFF for one-shot task runs): pi handles the
  post-compaction continuation itself (threshold → compact +
  `agent.continue()`; overflow mid-turn → compact + auto-retry), all before
  `agent_settled`, so 2pizzas needs no re-prompting logic; `compaction_start`/
  `end` surface in the UI as a status line + `compacted` transcript marker.
  The container joins the `gitea_gitea` compose network (`CHAT_NETWORK`)
  and is reached by container name — never publish host ports for this (a 127.0.0.1 publish
  is invisible to the 2pizzas container, which is itself a container). Chat containers
  act as the separate **`chat` Gitea user** (`CHAT_GITEA_TOKEN`,
  write:repository, seeded like the agent users): they can read any repo and
  push/post ONLY where granted — per-repo write grants are
  collaborator permissions managed from the `/chat` UI
  (`POST /api/chat/grant`, tracked in `chat_grants`). This keeps
  chat-driven work auditable apart from task work (and `enqueue()`
  ignores the `chat` sender, so chat posts never spawn tasks). The
  `/chat` grant UI re-verifies each `chat_grants` row against the real
  collaborator permission on every page load (a human can revoke the
  collaborator in Gitea directly) and drops stale rows — only a confirmed
  404 drops, an API blip keeps the row. Chat containers are capped at
  `CHAT_MEMORY`/`CHAT_CPUS` (default 4g/2 — inference is on the host's
  llama.cpp, the container is just node + git + light builds). With no
  `CHAT_GITEA_TOKEN` they fall back to NO Gitea token (read the 2pizzas
  task API via `host.docker.internal` only). Chat containers reach
  Gitea via `host.docker.internal:3000` — the runsc sandbox CANNOT use
  Docker's built-in DNS, so the compose service name `gitea` does not
  resolve inside them. They die on 2pizzas restart
  (orphans are reaped at startup via the `tea-chat-*` name filter) or
  after `CHAT_IDLE_MINUTES` (default 30) — a streaming turn never counts
  as idle (a long tool run emits no stream events). Every session is
  RECORDED in the `chat_sessions` sqlite table (agent, model, created/
  ended, end reason, message count, log file) — `/chat` lists past
  sessions and `/chat/<id>` of an ended session renders a read-only
  transcript from its log (`chatHistory()`; the log IS the transcript).
  chatSeq ids restart at 1 per 2pizzas run, so a dead id resolves to the
  newest row with it; ALL writes to the table are scoped by rowid (a bare
  `WHERE id=?` hits older same-id rows), and live-row matching compares
  `created_at` (`chatRowLive()`). The model + ctx-usage line under the chat
  input comes from pi's `get_session_stats` (`contextUsage` — pi's own
  window estimate), queried after every `agent_settled`; last value persists
  in `chat_sessions.tokens`. A 2pizzas restart backfills `ended_at` on
  orphaned rows (`2pizzas restart`). Optional `UI_TOKEN` gates the WHOLE
  2pizzas UI (every page + API; `/webhook`, `/healthz` and the theme asset
  bypass; `CHAT_TOKEN` is accepted as the value and as a fallback when
  `UI_TOKEN` is unset — the UI is tailnet-reachable). Token UX: the 401 is
  an UNLOCK form (a just-rejected token shows the form instead of
  auto-redirecting — that would loop), the token is stored in browser
  localStorage, and a request authenticated via `?token=`/`x-ui-token`
  sets a 30-day HttpOnly `tea_ui_token` cookie — after the first unlock
  every page works bare (cookie checked first, then param/header). The
  chat gate additionally accepts the UI cookie/token, so one unlock covers
  both. `/settings` manages the saved token (save/clear) and
  `POST /api/chat/logout` clears the session cookies. Killing the
  `docker run` client does NOT remove the container — `chatKill()` does
  `docker rm -f` by name (docker 29 no longer prints the container id).
  The compose `name: gitea` pin keeps the network `gitea_gitea`.
- **The standard CI runner (`my-runner`, label `ubuntu-latest`, runc) is
  separate** and only runs ordinary CI (e.g. `mirror-to-github.yaml`). It is
  NOT used for agents.
- **`android-runner` (label `android`)** is a second, dedicated runner for
  native Android builds (Capacitor APKs). Its
  job image `gitea-android:latest` (`runner/android/Dockerfile`) bakes JDK 21
  + Android SDK + a **pre-warmed `~/.gradle`** on the stock ubuntu-latest job
  image — job containers are ephemeral, so the image layer is the only place
  a Gradle cache survives between runs. Rebuild it when the baked
  Capacitor/AGP/SDK set changes. Release signing (if/when needed): keystore
  is a secret → `.env` + runner `env:`, never baked into the image.

## Golden rules

1. **Never commit secrets.** All secrets live in `.env` (gitignored). Config
   files use `${VAR}` placeholders that compose expands. New secret → add to
   `.env` + `.env.example` (placeholder) + `.gitignore` if it's a per-machine
   file.
2. **Example-file pattern for baked-in secrets.** Anything COPY'd into an image
   that contains a secret: commit `<name>.example` with placeholders, gitignore
   the real file, and add a build guard (`test -f ... || (echo hint && false)`)
   in the Dockerfile. See `pi/pi-settings/` and `opencode/opencode-config/`.
3. **`agents-actions/` is the template repo** on Gitea — `seed.sh` pushes it
   (force). It is now a thin README (the agent workflows it used to carry are
   gone). `sync-template.sh` is prune-only: it removes superseded agent
   workflow files from template-based repos. Ask before pushing.
4. **Runtime state dirs are off-limits**: `gitea/`, `postgres/`, `data/`,
   `data-agent/`, `data-2pizzas/`, `data-android/` — container-populated,
   gitignored.

## Key files

| File | Controls |
|---|---|
| `docker-compose.yml` | gitea server, postgres, my-runner, **2pizzas** (env injection: `${VAR}` from `.env`) |
| `2pizzas/server.mjs` | thin HTTP router only — logic is in sibling modules: `config.mjs`, `db.mjs` (sqlite), `gitea.mjs` (API), `repos.mjs` (managed repos/enroll), `inference.mjs` (backend registry + model pick + bake-sync check), `theme.mjs` (Gitea theme mirror), `prompts.mjs`, `queue.mjs` (enqueue + review chain), `tasks.mjs` (runsc job runner + pump + afterTask), `redact.mjs` (scrubs all 2pizzas-held secrets from task/chat log lines — applied at the two log choke points, don't remove it), `webhook.mjs`, `poll.mjs` (60s fallback), `chat.mjs` (pi RPC bridge), `ui/*.mjs` (dashboard pages). Import graph is acyclic; side-effect imports (pump/poll intervals, theme discovery, chat reaper) run at module load |
| `inference.json` | inference backend registry (gitignored; `inference.json.example` committed) — see the backend-agnostic bullet above; also editable from the `/backends` UI |
| `2pizzas/probe.sh` | CLI to probe a backend FROM 2pizzas's container vantage (the `POST /api/backends/test` endpoint) — `./2pizzas/probe.sh [url] [key]`; the diagnostic for a loopback-bound backend |
| `2pizzas/Dockerfile` | 2pizzas image (node + docker-cli) |
| `2pizzas/assets/post-comment.sh` | posts the agent reply, stamps `<!-- via:agent -->` |
| `2pizzas/assets/output_filter.mjs` | filters pi's `--mode json` stream into a readable log (node, NOT jq — jq buffers piped output) |
| `2pizzas/assets/opencode_filter.mjs` | same for `opencode run --format json` (tokens = last step_finish total = peak ctx + output) |
| `seed.sh` | idempotent bootstrap: users (admin + pi/opencode/infra/review + chat), tokens, repos, template, my-runner, **global webhook**, agent collaborators — safe to re-run |
| `setup.sh` | one-command interactive setup wizard: preflight → agent model configs (from `.example` + live router model list) → `.env` → image builds → compose up → seed → verify + summary. Idempotent; flags `--yes` / `--rebuild` / `--skip-build` / `--no-android` |
| `uninstall.sh` | inverse of setup.sh — tears down the stack behind a confirm: `docker compose down` (project `gitea` + `gitea_gitea` net), leftover `tea-chat-*` containers, built images (`agent-sandbox:*`, `gitea-android`, `gitea-pages`, 2pizzas); host data dirs only with `--purge`. Flags `--yes` / `--purge` / `--keep-images`. Never touches the git checkout or the host `ufw` rule |
| `sync-template.sh` | prune-only: removes superseded agent workflow files from template repos |
| `agents-actions/` | template repo content (README-only now) |
| `runner/config.yaml` | my-runner: `ubuntu-latest` label (ordinary CI only) — shared by android-runner |
| `runner/android/Dockerfile` | `gitea-android:latest` job image: JDK 21 + Android SDK + warm `~/.gradle` (label `android`) |
| `agent-sandbox/**/Dockerfile` | agent job images (`agent-sandbox:base` → `:pi` / `:opencode` / `:ops` / `:review`) |
| `agent-sandbox/review/skills/code-review/SKILL.md` | the reviewer's baked review skill (opencode skill dir) |
| `agent-sandbox/infra/Dockerfile` | `agent-sandbox:infra` = pi + docker-cli (runc + docker socket, see infra agent) |
| `agent-sandbox/pi/pi-settings/models.json` | pi's model providers (baked from `inference.json`, gitignored) |
| `agent-sandbox/opencode/opencode-config/opencode.json` | opencode's model provider (gitignored) |
| `gitea-policy.yaml` | sandbox network egress policy for agent binaries |
| `.gitea/workflows/` | ordinary CI workflows — `mirror-to-github.yaml`, `security-scan.yaml` (gitleaks + semgrep gate on every PR) — run on my-runner |
| `pages/` | static pages server (`Dockerfile`, `nginx.conf`, `entrypoint.sh`): syncs a repo's `gh-pages` branch and serves it on `:3002` (stand-in for Gitea Pages, which 1.27 lacks) |

## Useful commands

```bash
# One-command setup + its inverse (teardown, confirm-gated)
./setup.sh            # wizard: preflight → configs → .env → images → up → seed → verify
./uninstall.sh        # down the stack + remove built images; --purge also deletes data dirs

# Bootstrap (idempotent — users/tokens/repos/runner/webhooks; re-runnable)
./seed.sh

# Stack
docker compose ps
docker compose logs -f <server|db|runner|2pizzas>
docker compose up -d <service>        # recreates — REQUIRED after env/config changes
docker compose down

# 2pizzas (the dispatcher)
curl -s http://127.0.0.1:3001/healthz
curl -s http://127.0.0.1:3001/api/tasks | jq
#   task log: data-2pizzas/logs/<id>.log
#   dashboard: http://127.0.0.1:3001
#   after editing 2pizzas/server.mjs: docker compose build 2pizzas && docker compose up -d 2pizzas

# Agent job images
docker build -t agent-sandbox:base agent-sandbox
docker build -t agent-sandbox:pi agent-sandbox/pi
docker build -t agent-sandbox:opencode agent-sandbox/opencode
docker build -t agent-sandbox:ops agent-sandbox/ops
docker build -t agent-sandbox:infra agent-sandbox/infra
docker run --rm --entrypoint sh agent-sandbox:pi -c '<smoke test>'

# Android job image (android-runner, label `android`)
docker build -t gitea-android:latest runner/android

# Database (Gitea internals)
docker exec -it gitea-db-1 psql -U postgres -d gitea
#   interesting tables: action_runner, action_run, user, repository
#   2pizzas's task queue is a separate sqlite file under data-2pizzas/

# Gitea CLI — run directly as git; `su` does NOT work inside the container
docker exec -u git gitea gitea admin user create --username X --email X@localhost --password P
docker exec -u git gitea gitea admin user generate-access-token --username X --token-name N --scopes all --raw

# Gitea API (tokens in .env)
curl -s -H "Authorization: token $ADMIN_TOKEN" http://localhost:3000/api/v1/repos/admin/<repo>

# The 2pizzas webhook is GLOBAL (is_system_webhook) — lives in the db, no API:
docker exec gitea-db-1 psql -U postgres -d gitea -c "SELECT id, url, is_active FROM webhook WHERE is_system_webhook;"
```

## Gotchas (learned the hard way)

- **2pizzas env changes need `docker compose up -d 2pizzas`** (recreate), not
  `docker restart`. Edit `2pizzas/server.mjs` → also `docker compose build
  2pizzas` first (the file is COPY'd into the image).
- **A host firewall that drops FORWARD kills the stack silently.** Docker
  published ports (DNAT→bridge) AND embedded DNS (127.0.0.11) both traverse
  the FORWARD chain to the compose bridge `gitea_gitea` (172.18.0.0/16).
  `ufw default incoming deny` with no route rule: ports 3000/3001 go
  unreachable AND containers crash-loop on `lookup gitea: server
  misbehaving` (runners) / `lookup db` (gitea). Fix:
  `sudo ufw route allow in on any to 172.18.0.0/16` (+ `ufw allow` for ssh
  from the tailnet, or you lock yourself out). setup.sh preflight now OFFERS to
  apply both route rules (compose bridge + the default bridge job containers
  run on).
- **A backend bound to the host's `127.0.0.1`/localhost is invisible to every
  container.** Inside a container, `127.0.0.1` is that container's OWN
  loopback — 2pizzas and the job containers can never reach the host's
  loopback, so a llama.cpp/vLLM/Ollama bound to `127.0.0.1:8080` is
  unreachable from the stack (a routable host IP — tailscale/LAN — works).
  It's silent: `pickModel()` skips the backend and the task fails with
  "no backend reachable". Diagnose from the container's vantage, not the
  host's: `./2pizzas/probe.sh <url>` (or the "test"/"test url" buttons on the
  `/backends` page → `GET /api/backends/:id/test` / `POST /api/backends/test`)
  — a loopback url returns the exact hint.
- **Container `/etc/resolv.conf` is baked at creation time** from the
  host's resolver. If the host DNS was broken at that moment (e.g.
  `/etc/resolv.conf` pointing at the systemd-resolved stub `127.0.0.53`),
  the container gets `nameserver 127.0.0.53` — unreachable from inside —
  and can never resolve names until recreated:
  `docker compose up -d --force-recreate <svc>`. setup.sh verification
  checks `docker exec gitea getent hosts db` for exactly this.
- **Gitea webhooks are host-restricted.** By default Gitea refuses to call
  webhook URLs on private/LAN hosts. `docker-compose.yml` sets
  `GITEA__security__ALLOWED_HOST_LIST=2pizzas`; a new dispatcher hostname must
  be added there or deliveries silently fail (check `docker logs gitea` for
  "webhook can only call allowed HTTP servers").
- **PR comments fire `pull_request_comment`, not `issue_comment`.** A
  comment on an issue that is a PR is delivered under the
  `pull_request_comment` event; if that event isn't in the system webhook's
  events JSON the delivery is never created (silent). 2pizzas's
  `handleWebhook()` treats both event names identically (same payload
  shape: `comment` + `issue`); seed.sh's `HOOK_EVENTS` enables both and
  refreshes `events` on re-run.
- **Gitea 1.27 has NO API for system (global) webhooks** — the admin UI
  writes them straight to the `webhook` table, so seed.sh does the same via
  psql (`is_system_webhook=true`, `repo_id=0`, `type='gitea'`,
  `content_type=1`, events JSON with `issue_comment` + `pull_request_review`).
  Gitea picks new rows up **without a restart**. `pull_request_review_comment`
  is NOT a valid webhook event in 1.27 — only `pull_request_review` (full
  reviews). Inline review comments are picked up by the poll fallback.
- **Docker `-e` values have their newlines flattened to spaces.** Multi-line
  content (the bootstrap script, the agent prompt, helper scripts) must not be
  passed via `-e`. `runTask()` instead builds a self-contained script (prompt +
  helpers via quoted heredocs) and passes it base64-encoded, decoded inside the
  container. Don't "simplify" this back to `-e`.
- **2pizzas talks to the host docker daemon**, so a container path like
  `/data/work/N` is NOT a host path — you cannot bind-mount it into the job
  container. The job container clones the repo itself (as the task's agent
  user, authenticated remote → commits/PRs attribute to that user).
- **Loop prevention** is the `<!-- via:agent -->` marker (posted by
  `2pizzas/assets/post-comment.sh`, checked by `enqueue()`). Don't remove it
  from either side.
- **Agents post as their own users** (`pi`/`opencode`/`infra`/`review`; old
  instances also have the dormant `bot`), and older comments may be from the
  admin user — don't write actor-based logic; use the marker.
- **opencode non-interactive runs auto-REJECT permission prompts** (writing
  outside the workspace, e.g. `/tmp/reply.md`, silently fails and the agent
  stops). The bootstrap therefore runs `opencode run --auto` — safe because
  the gVisor sandbox is the real boundary, not opencode's permissions.
- **The reviewer is read-only by token, not by prompt.** Review tasks clone
  with `REVIEW_TOKEN` (read scope) and never receive `AGENT_TOKEN`, so
  push/post both 403. The review body travels back through the task log
  (`[2pizzas] review-body-*` markers) and 2pizzas posts it. Don't give the
  review container the write token "to make posting easier" — that silently
  re-arms the reviewer.
- **pi exits 0 even when the model/provider fails** (it retries 3×, then ends
  the `--mode json` stream with an error event and exits cleanly). The
  bootstrap therefore runs the pipeline under `bash -o pipefail` (the image's
  `sh` is dash — no pipefail) and checks the stream: a healthy pi run's LAST
  line is `"type":"agent_settled"` — the SESSION-end event, emitted in
  `prompt()`'s `finally` after `agent_end` and all post-run processing
  (retries, compaction). `agent_end` only closes the agent LOOP and is NOT the
  last line (pi 0.82+); checking for it as the terminator marks every task a
  failure. The check also requires the last `agent_end` to carry no
  `errorMessage` and no `finalError` (exhausted auto-retry) anywhere in the
  stream. opencode: last line must be `"type":"step_finish"`.
  Don't inline the pipeline back into the dash script — the `bash -c` subshell
  only sees `PROMPT` because it is `export`ed.
- **The agent images bake the model list AND the default model** at build
  time (pi: `models.json` + `settings.json`; opencode: `opencode.json`) —
  both generated by `setup.sh` from `inference.json` (all backends as
  providers). If the model set changes, re-run `./setup.sh --rebuild`. A
  per-task `--model <provider>/<id>` missing from the baked config fails with
  an opaque agent error — `checkBakedSync()` in `inference.mjs` catches this
  up front and logs `[2pizzas] WARNING: … run ./setup.sh --rebuild` in the
  task log; don't remove that check.
- **pi 0.82+ has auto-compaction ON by default** and runs it in
  `_handlePostAgentRun()` — i.e. it emits `compaction_start`/`compaction_end`
  to the `--mode json` stream AFTER the `agent_end` line (a full extra
  summarization LLM call at the end of a one-shot run — pure downside, it can
  never fire mid-task). It's baked OFF in
  `agent-sandbox/pi/pi-settings/settings.json` (`"compaction":
  {"enabled": false}`). Don't re-enable it.
  Related trap: `pi --model llama.cpp/<id>` for an id MISSING from the baked
  `models.json` silently inherits `contextWindow` from the FIRST model in the
  provider list (`buildFallbackModel`) — a 131K task on a model that resolves
  to a 65K window trips the compaction threshold (`ctx > window − 16384`).
  Keep `models.json` in sync with the host model set.
- **pi (0.82.x) does not interpolate env vars in `apiKey`** despite the docs —
  the key must be baked into `models.json` at image build time.
  0.82+ also needs Node >= 22.19 (base image is on 22) and bakes
  `LLAMA_BASE_URL` into `agent-sandbox:pi` — without it the bundled
  llama.cpp extension provider fails auth with "Provider is not configured".
- **User-controlled content in shell**: always pass it via env vars / quoted
  heredocs, never unquoted interpolation of comment bodies.
- **Repo creation via API needs `write:user` scope** — use `ADMIN_TOKEN`, not
  `GITEA_TOKEN`.
- **Update a repo via API with PATCH** (PUT on `/repos/{owner}/{name}` is 405).
- **Newer git defaults to `master`** — push with `git push origin master:main`
  if the target repo uses `main`.
- **GVisor (`runsc`) still sandboxes every agent job**; the dispatcher holds the
  docker socket (host control is the point of 2pizzas). Keep job containers
  ephemeral (`--rm`) — one-shot isolation per task is a feature, not a cost.
- **Gitea 1.27 has NO native Pages** (no route, no db state, no API — `ENABLE_PAGES`
  is a no-op). Static previews are served by the `pages` compose service, which
  polls the repo's `gh-pages` branch (a CI workflow in the target repo
  builds the app and pushes it there) and nginx-serves it on `:3002`.
- **Gitea Actions does not export `GITEA_REF`/`GITEA_REF_NAME`** as shell env
  vars (unbound under `set -u`) — in workflow scripts use `git rev-parse` instead.
  The `${{ github.* }}` context expressions DO work in `with:` blocks.

## Ops agent (parked)

The `@ops` agent and `ops-assist.yaml` were removed (see git history,
"ops agent parked"). The `agent-ops` runner label no longer exists. If it is
revived it should run through 2pizzas, not a dedicated runner.

## Verification after changes

| Changed | Verify with |
|---|---|
| compose / `.env` | `docker compose config -q` + recreate the service + `docker exec <container> printenv VAR` |
| `2pizzas/server.mjs` | `node --check`, then `docker compose build 2pizzas && up -d`, `curl :3001/healthz` |
| webhook delivery | post `@pi` on a throwaway issue; `docker logs gitea-2pizzas` shows `[webhook] … → enqueued`, task goes to `success` in the UI |
| chat | `curl -X POST :3001/api/chat -d '{"agent":"pi"}'` → `POST /api/chat/<id>/message` → SSE `/chat/<id>/stream` shows `text_delta`…`agent_settled`; `DELETE /api/chat/<id>` removes the container |
| backends | `curl -X POST :3001/api/backends -d '{"id":"x","url":"https://…"}'` → row appears in `inference.json` (in place) + the `/backends` page (with a "not baked" badge until `./setup.sh --rebuild`); `DELETE /api/backends/:id` removes it (the last one is protected). Reachability: `./2pizzas/probe.sh <url>` (or the "test" buttons) → `ok` + model list, or `NOT reachable` + the loopback hint |
| agent image | rebuild, `docker run --rm --entrypoint sh agent-sandbox:<a> -c '<agent> --version'` |
| review chain | work task that pushes → `agent-review` task appears (read-only clone) → review comment with `<!-- review:pass/fail -->` on the issue; `fail` → `rework` task (round 2); chain caps at `REVIEW_MAX_ROUNDS` |
| infra agent | `@infra` on an issue in `INFRA_REPO` → task runs (runc, `docker ps` works inside); a task killed with 143/137 → retry task + `agent-infra` task on a new incident issue within the cooldown |
| `pages/` | `docker compose build pages && up -d pages`, `curl -I http://localhost:3002/` (200 + app HTML; updates within ~60s of a gh-pages push) |
| end-to-end | full loop: `@pi` comment → task `success` → `pi` reply with `<!-- via:agent -->` on the issue |
