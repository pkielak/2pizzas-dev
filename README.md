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
| `agent-sandbox:*` images | Docker images the agent tasks run in: a base image + one variant per agent (pi, opencode, ops=pi+docker CLI), each preconfigured with a local llama.cpp model provider |

The **template repo `owner/agents-actions`** is a thin README (the old agent
workflows are gone). The authoritative copy lives in the `agents-actions/`
directory in this repo (`seed.sh` pushes it).

## Repository layout

```
docker-compose.yml          # gitea + db + runner + 00-tea
seed.sh                     # one-shot bootstrap: users, tokens, repos, runners
sync-template.sh            # push agents-actions updates into template-based repos
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

### Prerequisites

- Docker + compose plugin
- A llama.cpp server (OpenAI-compatible, `:8080`) reachable from the host —
  the agents talk to it through `host.docker.internal` (mapped to
  `host-gateway` in compose)
- Ports 3000 (web) and 222 (SSH) free

### 1. Configure secrets

```bash
cp .env.example .env
$EDITOR .env   # postgres user/password at minimum
```

### 2. Start and seed

```bash
docker compose up -d db server
./seed.sh
```

`seed.sh` is idempotent and does the rest:

1. waits for Gitea on `:3000`
2. creates the admin (`ADMIN_USER`) and `bot` users — passwords from `.env`,
   generated and written back if absent
3. generates all API tokens (`GITEA_TOKEN`, `AGENT_TOKEN`, `ADMIN_TOKEN`) and
   writes them into `.env`
4. creates and pushes both repos — this checkout as `gitea-with-agents`, the
   `agents-actions/` directory as the template — and marks it `template: true`
5. mints the runner registration tokens via the admin API → `.env`
6. starts the runner (self-registers)

Agents act as a dedicated `bot` user so you can review their work (commits,
PRs, comments all show up under `bot`).

### 3. Build the agent images

```bash
# base first, then the variants
cd agent-sandbox
docker build -t agent-sandbox:base .
cd pi
cp pi-settings/models.json.example pi-settings/models.json   # fill in llama.cpp host + key
docker build -t agent-sandbox:pi .
cd ../opencode
cp opencode-config/opencode.json.example opencode-config/opencode.json  # same
docker build -t agent-sandbox:opencode .
cd ..
docker build -t agent-sandbox:ops ops     # pi + docker CLI, for the @ops agent
```

The real config files (`models.json`, `opencode.json`) contain the llama.cpp
API key and are gitignored; the builds fail fast with a hint if they're missing.

### 4. Create a repo from the template

1. New Repository → **Create from template → agents-actions**
2. Add `bot` as collaborator with **write** (Settings → Collaborators), or:
   `PUT /repos/{owner}/{repo}/collaborators/bot` with `{"permission":"write"}`

Now `@pi` / `@opencode` comments on that repo work.

### 5. Updating template-based repos

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
