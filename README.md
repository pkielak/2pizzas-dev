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
| `agent-runner` | Gitea Actions runner (gVisor) with labels `agent-pi` / `agent-opencode` — one job per agent, each running in its own sandbox image |
| `agent-sandbox:*` images | Docker images the agent jobs run in: a base image + one variant per agent (pi, opencode), each preconfigured with a local llama.cpp model provider |

The workflow files that make the agents work live in a separate **template
repo, [`agents-actions`](../agents-actions)** — any repo created from that
template gets the agent behavior out of the box.

## Repository layout

```
docker-compose.yml          # gitea + db + both runners
.env / .env.example         # all secrets (token, passwords) — .env is gitignored
gitea-policy.yaml           # sandbox egress policy for agent binaries (network allowlist)
agent-sandbox/
  Dockerfile                # base image: git, curl, jq, node
  pi/Dockerfile             # + pi coding agent + settings
  pi/pi-settings/           # models.json (gitignored) + models.json.example
  opencode/Dockerfile       # + opencode agent + config
  opencode/opencode-config/ # opencode.json (gitignored) + .example
runner/config.yaml          # my-runner: ubuntu-latest label
runner-agent/config.yaml    # agent-runner: agent-pi / agent-opencode labels + job envs
.gitea/workflows/           # working copy of the agent workflows (mirror of agents-actions)
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
$EDITOR .env   # postgres user/password
```

### 2. Start Gitea

```bash
docker compose up -d db server
```

Open http://localhost:3000 and create the admin user on first run.

### 3. Create the bot user and tokens

Agents act as a dedicated `bot` user so you can review their work:

```bash
# bot user
docker exec -u git gitea gitea admin user create \
  --username bot --email bot@localhost --password '<generate one>'

# token for the bot (printed once — put it in .env as AGENT_TOKEN)
docker exec -u git gitea gitea admin user generate-access-token \
  --username bot --token-name runner --scopes write:issue,write:repository

# full-scope token for repo management (ADMIN_TOKEN in .env)
docker exec -u git gitea gitea admin user generate-access-token \
  --username <admin> --token-name repo-admin --scopes all --raw
```

Fill `GITEA_TOKEN` (owner token, needs at least `write:issue,write:repository`
— and *not* just those for repo creation), `AGENT_TOKEN`, `ADMIN_TOKEN` in
`.env`.

### 4. Build the agent images

```bash
# base first, then the variants
cd agent-sandbox
docker build -t agent-sandbox:base .
cd pi
cp pi-settings/models.json.example pi-settings/models.json   # fill in llama.cpp host + key
docker build -t agent-sandbox:pi ..
cd ../opencode
cp opencode-config/opencode.json.example opencode-config/opencode.json  # same
docker build -t agent-sandbox:opencode ..
```

The real config files (`models.json`, `opencode.json`) contain the llama.cpp
API key and are gitignored; the builds fail fast with a hint if they're missing.

### 5. Register the runners

1. In Gitea: *Admin Console → Actions → Runners* (or a repo's *Settings →
   Actions → Runners*) → create two registration tokens.
2. Put them in `.env`: `GITEA_RUNNER_REGISTRATION_TOKEN` (for my-runner) and
   `GITEA_AGENT_RUNNER_REGISTRATION_TOKEN` (for agent-runner).
3. Start them:

```bash
docker compose up -d runner agent-runner
docker logs -f gitea-agent-runner   # "runner registered" = done
```

### 6. Create a repo from the template

1. New Repository → **Create from template → agents-actions**
2. Add `bot` as collaborator with **write** (Settings → Collaborators), or:
   `PUT /repos/{owner}/{repo}/collaborators/bot` with `{"permission":"write"}`

Now `@pi` / `@opencode` comments on that repo work.

## Day-2 operations

| Task | Command |
|---|---|
| Stop / start everything | `docker compose down` / `docker compose up -d` |
| Rebuild one agent image | edit config → `docker build -t agent-sandbox:<agent> agent-sandbox/<agent>` |
| Change runner envs/labels | edit `runner*/config.yaml` + compose envs, then `docker compose up -d <service>` (**recreate**, a plain restart won't reload env) |
| DB access | `docker exec -it gitea-db-1 psql -U <user> -d gitea` |
| Gitea CLI | `docker exec -u git gitea gitea admin ...` (no `su` inside the container — run directly as `git`) |
| Gitea API | `curl -H "Authorization: token $ADMIN_TOKEN" http://localhost:3000/api/v1/...` |

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
