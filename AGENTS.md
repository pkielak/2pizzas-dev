# AGENTS.md

Instructions for AI agents (pi, opencode, ...) working in this repository.

## What this repo is

Infrastructure-as-code for a local Gitea instance with a webhook-driven AI
agent dispatcher (`00-tea`). Everything here is live: the running Docker
containers were started from this directory. Changing a file and not
restarting/rebuilding the matching container means the change has no effect.

## How the agent automation works

A `@pi` / `@opencode` mention on an issue or PR in a managed repo becomes an
agent task. The pipeline (replaces the old Gitea-Actions agent workflows):

```
Gitea webhook ──► 00-tea (sqlite queue) ──► docker run --runtime=runsc agent-sandbox:<agent>
                                              (one-shot, gVisor-sandboxed)
                                              └─► agent works, posts reply via post-comment.sh
```

- **00-tea** (`00-tea/server.mjs`, image built from `00-tea/Dockerfile`) is a
  single Node service. It receives ONE **global (system) Gitea webhook** that
  fires for every repo on the instance (00-tea gates on `AGENTD_REPOS` +
  `@agent` mentions), dedupes + queues tasks in sqlite, and runs each task as
  an ephemeral `docker run --rm --runtime=runsc agent-sandbox:<agent>` container.
- **Webhooks are at-least-once** → deliveries and tasks are deduped on
  `(repo, kind, comment_id)`. A 60s poll fallback (managed repos only) rescues
  any webhook Gitea never delivered.
- **New managed repo** = append to `AGENTD_REPOS` in `.env` → `./seed.sh`
  (adds the bot as write collaborator; the global webhook needs no change) →
  `docker compose up -d 00-tea`.
- **Loop prevention**: replies are stamped `<!-- via:agent -->` by
  `00-tea/assets/post-comment.sh`; comments carrying that marker (or authored
  by the bot) are never enqueued.
- **UI / observability**: task dashboard at `http://127.0.0.1:3001`,
  per-task logs in `data-00-tea/logs/<id>.log`, `GET /api/tasks`. Running
  tasks show a **live log view**: `GET /task/:id/stream` is an SSE tail that
  emits each log line as it hits the file. The whole path is unbuffered:
  pi prints JSON lines live → `output_filter.mjs` (node) writes each match
  immediately → docker pipe → `appendFileSync`. Do NOT "simplify" the filter
  back to jq — jq buffers piped stdout until the process exits.
- **The UI mirrors the configured Gitea theme.** 00-tea reads the operator's
  theme from the db (`docker exec gitea-db-1 psql …` — Gitea 1.27's user API
  omits the theme field) and the theme→css-file map by grepping the gitea
  binary (content-hashed filenames, ~15s → runs in the background), then
  serves Gitea's theme CSS same-origin at `/assets/gitea-theme.css`. All UI
  colors are Gitea `--color-*` variables with hardcoded dark fallbacks, so it
  degrades gracefully if Gitea is down. Result persists in
  `data-00-tea/theme.json` (10-min TTL); the first page after a cold start
  renders with the fallback palette for ~15s until discovery finishes.
  Finished tasks show the last 400 lines statically.
- **The standard CI runner (`my-runner`, label `ubuntu-latest`, runc) is
  separate** and only runs ordinary CI (e.g. `mirror-to-github.yaml`). It is
  NOT used for agents.

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
   `data-agent/`, `data-00-tea/` — container-populated, gitignored.

## Key files

| File | Controls |
|---|---|
| `docker-compose.yml` | gitea server, postgres, my-runner, **00-tea** (env injection: `${VAR}` from `.env`) |
| `00-tea/server.mjs` | the dispatcher: webhook receiver, sqlite queue, task runner, UI |
| `00-tea/Dockerfile` | 00-tea image (node + docker-cli) |
| `00-tea/assets/post-comment.sh` | posts the agent reply, stamps `<!-- via:agent -->` |
| `00-tea/assets/output_filter.mjs` | filters pi's `--mode json` stream into a readable log (node, NOT jq — jq buffers piped output) |
| `seed.sh` | idempotent bootstrap: users, tokens, repos, template, my-runner, **global webhook**, bot collaborators — safe to re-run |
| `sync-template.sh` | prune-only: removes superseded agent workflow files from template repos |
| `agents-actions/` | template repo content (README-only now) |
| `runner/config.yaml` | my-runner: `ubuntu-latest` label (ordinary CI only) |
| `agent-sandbox/**/Dockerfile` | agent job images (`agent-sandbox:base` → `:pi` / `:opencode` / `:ops`) |
| `agent-sandbox/pi/pi-settings/models.json` | pi's model provider (llama.cpp, gitignored) |
| `agent-sandbox/opencode/opencode-config/opencode.json` | opencode's model provider (gitignored) |
| `gitea-policy.yaml` | sandbox network egress policy for agent binaries |
| `.gitea/workflows/` | ordinary CI workflows (e.g. `mirror-to-github.yaml`) — run on my-runner |
| `pages/` | static pages server (`Dockerfile`, `nginx.conf`, `entrypoint.sh`): syncs a repo's `gh-pages` branch and serves it on `:3002` (stand-in for Gitea Pages, which 1.27 lacks) |

## Useful commands

```bash
# Bootstrap (idempotent — users/tokens/repos/runner/webhooks; re-runnable)
./seed.sh

# Stack
docker compose ps
docker compose logs -f <server|db|runner|00-tea>
docker compose up -d <service>        # recreates — REQUIRED after env/config changes
docker compose down

# 00-tea (the dispatcher)
curl -s http://127.0.0.1:3001/healthz
curl -s http://127.0.0.1:3001/api/tasks | jq
#   task log: data-00-tea/logs/<id>.log
#   dashboard: http://127.0.0.1:3001
#   after editing 00-tea/server.mjs: docker compose build 00-tea && docker compose up -d 00-tea

# Agent job images
docker build -t agent-sandbox:base agent-sandbox
docker build -t agent-sandbox:pi agent-sandbox/pi
docker build -t agent-sandbox:opencode agent-sandbox/opencode
docker build -t agent-sandbox:ops agent-sandbox/ops
docker run --rm --entrypoint sh agent-sandbox:pi -c '<smoke test>'

# Database (Gitea internals)
docker exec -it gitea-db-1 psql -U USER -d gitea
#   interesting tables: action_runner, action_run, user, repository
#   00-tea's task queue is a separate sqlite file under data-00-tea/

# Gitea CLI — run directly as git; `su` does NOT work inside the container
docker exec -u git gitea gitea admin user create --username X --email X@localhost --password P
docker exec -u git gitea gitea admin user generate-access-token --username X --token-name N --scopes all --raw

# Gitea API (tokens in .env)
curl -s -H "Authorization: token $ADMIN_TOKEN" http://localhost:3000/api/v1/repos/owner/<repo>

# The 00-tea webhook is GLOBAL (is_system_webhook) — lives in the db, no API:
docker exec gitea-db-1 psql -U USER -d gitea -c "SELECT id, url, is_active FROM webhook WHERE is_system_webhook;"
```

## Gotchas (learned the hard way)

- **00-tea env changes need `docker compose up -d 00-tea`** (recreate), not
  `docker restart`. Edit `00-tea/server.mjs` → also `docker compose build
  00-tea` first (the file is COPY'd into the image).
- **Gitea webhooks are host-restricted.** By default Gitea refuses to call
  webhook URLs on private/LAN hosts. `docker-compose.yml` sets
  `GITEA__security__ALLOWED_HOST_LIST=00-tea`; a new dispatcher hostname must
  be added there or deliveries silently fail (check `docker logs gitea` for
  "webhook can only call allowed HTTP servers").
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
- **00-tea talks to the host docker daemon**, so a container path like
  `/data/work/N` is NOT a host path — you cannot bind-mount it into the job
  container. The job container clones the repo itself (as `bot`, authenticated
  remote → commits/PRs attribute to the bot user).
- **Loop prevention** is the `<!-- via:agent -->` marker (posted by
  `00-tea/assets/post-comment.sh`, checked by `enqueue()`). Don't remove it
  from either side.
- **Bot posts as `bot`**, but older comments may be from `owner` — don't
  write actor-based logic; use the marker.
- **pi 0.74.2 does not interpolate env vars in `apiKey`** despite the docs —
  the key must be baked into `models.json` at image build time.
- **User-controlled content in shell**: always pass it via env vars / quoted
  heredocs, never unquoted interpolation of comment bodies.
- **Repo creation via API needs `write:user` scope** — use `ADMIN_TOKEN`, not
  `GITEA_TOKEN`.
- **Update a repo via API with PATCH** (PUT on `/repos/{owner}/{name}` is 405).
- **Newer git defaults to `master`** — push with `git push origin master:main`
  if the target repo uses `main`.
- **GVisor (`runsc`) still sandboxes every agent job**; the dispatcher holds the
  docker socket (host control is the point of 00-tea). Keep job containers
  ephemeral (`--rm`) — one-shot isolation per task is a feature, not a cost.
- **Gitea 1.27 has NO native Pages** (no route, no db state, no API — `ENABLE_PAGES`
  is a no-op). Static previews are served by the `pages` compose service, which
  polls the repo's `gh-pages` branch (Pancratius' `.gitea/workflows/pages.yaml`
  builds the app and pushes it there) and nginx-serves it on `:3002`.
- **Gitea Actions does not export `GITEA_REF`/`GITEA_REF_NAME`** as shell env
  vars (unbound under `set -u`) — in workflow scripts use `git rev-parse` instead.
  The `${{ github.* }}` context expressions DO work in `with:` blocks.

## Ops agent (parked)

The `@ops` agent and `ops-assist.yaml` were removed (see git history,
"ops agent parked"). The `agent-ops` runner label no longer exists. If it is
revived it should run through 00-tea, not a dedicated runner.

## Verification after changes

| Changed | Verify with |
|---|---|
| compose / `.env` | `docker compose config -q` + recreate the service + `docker exec <container> printenv VAR` |
| `00-tea/server.mjs` | `node --check`, then `docker compose build 00-tea && up -d`, `curl :3001/healthz` |
| webhook delivery | post `@pi` on a throwaway issue; `docker logs gitea-00-tea` shows `[webhook] … → enqueued`, task goes to `success` in the UI |
| agent image | rebuild, `docker run --rm --entrypoint sh agent-sandbox:<a> -c '<agent> --version'` |
| `pages/` | `docker compose build pages && up -d pages`, `curl -I http://localhost:3002/` (200 + app HTML; updates within ~60s of a gh-pages push) |
| end-to-end | full loop: `@pi` comment → task `success` → `bot` reply with `<!-- via:agent -->` on the issue |
