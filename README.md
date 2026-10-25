# gitea-with-agents

A local [Gitea](https://gitea.com) instance with **AI agent runners**: post a
comment on an issue or PR mentioning `@pi` or `@opencode` and the corresponding
coding agent implements the request — pushes commits, opens PRs, and replies
with a summary, all under a reviewable `bot` user.

## Components

| Service | What it is |
|---|---|
| `server` (gitea) | Gitea 1.27.2, web UI on `:3000`, SSH on `:222`, postgres backend |
| `db` | Postgres 14 |
| `runner` (my-runner) | Regular Gitea Actions runner (runc), label `ubuntu-latest` — for ordinary CI |
| `00-tea` | Webhook-driven AI agent dispatcher: receives Gitea webhooks, queues tasks in sqlite, runs each as an ephemeral gVisor-sandboxed container |
| `agent-sandbox:*` images | Docker images the agent tasks run in: a base image + one variant per agent (pi, opencode, ops=pi+docker CLI), each preconfigured with the inference backends from `inference.json` |
| `inference.json` | Registry of inference backends (any OpenAI-compatible `/v1` endpoint — local llama.cpp, vLLM, Ollama, OpenRouter, …). 00-tea walks them by priority with failover; `setup.sh` bakes the same list into the agent images |

The **template repo `owner/agents-actions`** is a thin README (the old agent
workflows are gone). The authoritative copy lives in the `agents-actions/`
directory in this repo (`seed.sh` pushes it).

## Repository layout

```
docker-compose.yml          # gitea + db + runner + 00-tea
setup.sh                    # one-command interactive setup wizard (8 steps)
seed.sh                     # one-shot bootstrap: users, tokens, repos, runners
sync-template.sh            # push agents-actions updates into template-based repos
inference.json              # inference backend registry (gitignored; .example committed)
.env / .env.example         # all secrets (token, passwords) — .env is gitignored
gitea-policy.yaml           # sandbox egress policy for agent binaries (network allowlist)
agents-actions/             # exact content of the agents-actions template repo (source of truth)
agent-sandbox/
  Dockerfile                # base image: git, curl, jq, node
  pi/Dockerfile             # + pi coding agent + settings
  pi/pi-settings/           # models.json (gitignored) + models.json.example
  opencode/Dockerfile       # + opencode agent + config
  opencode/opencode-config/ # opencode.json (gitignored) + .example
runner/config.yaml          # my-runner: ubuntu-latest label
.gitea/workflows/           # ordinary CI workflows
```

Runtime state (gitignored, do not edit): `gitea/` (Gitea data), `postgres/`,
`data/` (runner state), `data-00-tea/` (dispatcher state + task logs).

## Setup

### One command

```bash
./setup.sh
```

An interactive 8-step wizard takes a bare checkout to a running, fully
seeded stack:

1. **preflight** — docker/compose/jq/git, ports 3000/3001/3002/222, runsc,
   inference backend reachability
2. **inference backends** — builds/edits `inference.json` (the backend
   registry: any OpenAI-compatible endpoint — local llama.cpp router,
   vLLM, Ollama, OpenRouter, …) and bakes the same list into the gitignored
   `agent-sandbox/{pi,opencode}` model configs, using each backend's live
   model list
3. **`.env`** — generated (or finished) interactively: Gitea URL, admin user,
   postgres creds (auto-generated password), managed repos, CPU plan
4. **images** — builds `00-tea`, `gitea-pages`, `agent-sandbox:{base,pi,
   opencode,review,infra,ops}` and (asked) `gitea-android`
5. **Gitea + Postgres** — `compose up -d db server`, waits for health
6. **seed** — runs `seed.sh` (users, tokens, repos, runners, global webhook)
7. **full stack** — `compose up -d` for everything
8. **verify + summary** — API/dispatcher/runner/webhook/router checks, links,
   and a "try it" prompt

Every step is idempotent — re-run `./setup.sh` anytime (e.g. after changing
the model set: `./setup.sh --rebuild`). Flags:

| Flag | Effect |
|---|---|
| `--yes` | non-interactive: defaults + existing `.env` |
| `--rebuild` | force-rebuild all images |
| `--skip-build` | skip image builds |
| `--no-android` | skip the large `gitea-android` build |

### Prerequisites

- Docker + compose plugin
- A llama.cpp server (OpenAI-compatible, `:8080`) reachable from the host —
  the agents talk to it through `host.docker.internal` (mapped to
  `host-gateway` in compose)
- Ports 3000 (web) and 222 (SSH) free
- gVisor (`runsc`) — agent task sandboxes

### Manual setup (what the wizard does, step by step)

1. `cp .env.example .env` + fill in postgres creds (at minimum)
2. create the agent model configs from the `.example` files (wizard step 2)
3. build the images (wizard step 4)
4. `docker compose up -d db server && ./seed.sh` — idempotent: users,
   tokens → `.env`, repos, runner registration tokens, global webhook

Agents act as a dedicated `bot` user so you can review their work (commits,
PRs, comments all show up under `bot`).

New repos: create from the `agents-actions` template — they self-enroll on
the first `@pi`/`@opencode` mention (00-tea grants the bot write access
itself), so no manual collaborator step is needed.

### Updating template-based repos

Gitea templates are a one-time copy — they don't propagate changes. After
editing workflows in `agents-actions/`, push the update into each consuming
repo:

```bash
./sync-template.sh owner/repo [owner/repo ...]
```

It overwrites the template-managed files, removes superseded ones, leaves
repo-specific workflows (`ci.yml`, ...) alone, and only commits when something
actually changed.

## Day-2 operations

| Task | Command |
|---|---|
| Stop / start everything | `docker compose down` / `docker compose up -d` |
| Rebuild one agent image | edit config → `docker build -t agent-sandbox:<agent> agent-sandbox/<agent>` |
| Change runner envs/labels | edit `runner/config.yaml` + compose envs, then `docker compose up -d <service>` (**recreate**, a plain restart won't reload env) |
| DB access | `docker exec -it gitea-db-1 psql -U <user> -d gitea` |
| Gitea CLI | `docker exec -u git gitea gitea admin ...` (no `su` inside the container — run directly as `git`) |
| Gitea API | `curl -H "Authorization: token $ADMIN_TOKEN" http://localhost:3000/api/v1/...` |
| Push template updates into repos | edit `agents-actions/` → `./sync-template.sh owner/repo [...]` |

## How the agents work

A `@pi` / `@opencode` mention on an issue or PR in a managed repo triggers a
webhook to **00-tea**, which queues the task and runs it as an ephemeral
`docker run --runtime=runsc agent-sandbox:<agent>` container. The agent
checks out the repo, does the work (pushes commits, opens PRs), and posts a
reply via `post-comment.sh`.

Loop prevention: replies are stamped `<!-- via:agent -->`; comments carrying
that marker (or authored by the bot) are never enqueued.

The `agents-actions/` directory is a thin README-only template — new managed
repos are added by appending to `AGENTD_REPOS` in `.env` and re-running
`./seed.sh` (adds the bot as write collaborator; the global webhook needs no
change).

## Review feedback

Human review comments on a worker's PR are picked up: 00-tea enqueues a
`review` task when someone leaves an inline diff comment — the worker
addresses it (changes, commit, push to the PR head branch). Separately,
every work push goes through the automatic review chain (read-only
`agent-review` → `rework` rounds, capped — see AGENTS.md), and `@infra` on
this repo runs the infra agent, which repairs the stack itself (it is also
auto-enqueued on infra-class task failures).
