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
| `agent-runner` | Gitea Actions runner (gVisor) with labels `agent-pi` / `agent-opencode` / `agent-ops` — one job per agent, each running in its own sandbox image |
| `agent-sandbox:*` images | Docker images the agent jobs run in: a base image + one variant per agent (pi, opencode, ops=pi+docker CLI), each preconfigured with a local llama.cpp model provider |

The workflow files that make the agents work live in a separate **template
repo, `owner/agents-actions`** — any repo created from that template gets
the agent behavior out of the box. The authoritative copy of its content is
the `agents-actions/` directory in this repo (`seed.sh` pushes it); edit
workflows there, not on Gitea.

## Repository layout

```
docker-compose.yml          # gitea + db + both runners
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
runner-agent/config.yaml    # agent-runner: agent-pi / agent-opencode labels + job envs
.gitea/workflows/           # working copy of the agent workflows (staging for platform-fall)
```

Runtime state (gitignored, do not edit): `gitea/` (Gitea data), `postgres/`,
`data/` and `data-agent/` (runner state).

## Setup

### Prerequisites

- Docker + compose plugin
- A llama.cpp server (OpenAI-compatible, `:8080`) reachable from the host —
  the agents talk to it through `host.openshell.internal` (mapped to
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
6. starts both runners (they self-register)

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
./sync-template.sh owner/platform-fall [owner/repo ...]
```

It overwrites the template-managed files, removes superseded ones, leaves
repo-specific workflows (`ci.yml`, ...) alone, and only commits when something
actually changed.

## Day-2 operations

| Task | Command |
|---|---|
| Stop / start everything | `docker compose down` / `docker compose up -d` |
| Rebuild one agent image | edit config → `docker build -t agent-sandbox:<agent> agent-sandbox/<agent>` |
| Change runner envs/labels | edit `runner*/config.yaml` + compose envs, then `docker compose up -d <service>` (**recreate**, a plain restart won't reload env) |
| DB access | `docker exec -it gitea-db-1 psql -U <user> -d gitea` |
| Gitea CLI | `docker exec -u git gitea gitea admin ...` (no `su` inside the container — run directly as `git`) |
| Gitea API | `curl -H "Authorization: token $ADMIN_TOKEN" http://localhost:3000/api/v1/...` |
| Push template updates into repos | edit `agents-actions/` → `./sync-template.sh owner/repo [...]` |

## How the agents work

`agents-actions` ships two workflows:

- **`comment-assist.yaml`** — `issue_comment` on issues and PRs. Jobs
  `assist-pi` / `assist-opencode` fire when the comment mentions `@pi` /
  `@opencode`. The agent checks out the repo, does the work (pushes to the PR
  head branch, or opens a new PR from a branch), and posts a reply.
- **`pr-review.yml`** — `pull_request_review_comment` (inline diff comments)
  only, so it never fires on regular issues.

Loop prevention: replies are posted by `post-comment.sh` with a
`<!-- via:agent -->` marker; both workflows' `if:` exclude comments containing
it (the bot posts as itself, so actor-based checks would also work, but the
marker is robust to quoting/forwarding). All per-repo requirements are
documented in the template's README.

### Ops agent (infra repo only)

`gitea-with-agents` itself runs **`ops-assist.yaml`**: a `@ops <request>`
comment lets an agent operate the stack — diagnose (read-only), restart /
rebuild/re-register (operate), or propose changes to this repo as a PR
(improve). The job container gets the host's docker socket and a read-only
mount of this directory at `/infra` via per-job `container.options` in the
workflow. Improvements never push to `main` directly — merge the PR, then
`@ops apply #<n>` or run `./seed.sh` / `docker compose up -d` yourself.
This workflow is deliberately **not** in the template: repos created from it
must not get host docker access.
