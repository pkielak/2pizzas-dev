# AGENTS.md

Instructions for AI agents (pi, opencode, ...) working in this repository.

## What this repo is

Infrastructure-as-code for a local Gitea instance with AI agent runners.
Everything here is live: the running Docker containers were started from this
directory. Changing a file and not restarting/rebuilding the matching
container means the change has no effect.

## Golden rules

1. **Never commit secrets.** All secrets live in `.env` (gitignored). Config
   files use `${VAR}` placeholders that the runner/compose expands. New secret
   → add to `.env` + `.env.example` (placeholder) + `.gitignore` if it's a
   per-machine file.
2. **Example-file pattern for baked-in secrets.** Anything COPY'd into an image
   that contains a secret: commit `<name>.example` with placeholders, gitignore
   the real file, and add a build guard (`test -f ... || (echo hint && false)`)
   in the Dockerfile. See `pi/pi-settings/` and `opencode/opencode-config/`.
3. **`.gitea/workflows/` is a mirror** of the `agents-actions` template repo on
   Gitea. If you change a workflow here, it must be synced to that repo too
   (and to any repo using it, e.g. `platform-fall`) — ask before pushing.
4. **Runtime state dirs are off-limits**: `gitea/`, `postgres/`, `data/`,
   `data-agent/` — container-populated, gitignored.

## Key files

| File | Controls |
|---|---|
| `docker-compose.yml` | gitea server, postgres, both runners (env injection: `${VAR}` from `.env`) |
| `runner-agent/config.yaml` | agent-runner: labels (`agent-pi`, `agent-opencode`) + job envs (`GITEA_TOKEN`, `AGENT_TOKEN`) |
| `runner/config.yaml` | my-runner: `ubuntu-latest` label |
| `agent-sandbox/**/Dockerfile` | job container images (`agent-sandbox:base` → `:pi` / `:opencode`) |
| `agent-sandbox/pi/pi-settings/models.json` | pi's model provider (llama.cpp, gitignored) |
| `agent-sandbox/opencode/opencode-config/opencode.json` | opencode's model provider (gitignored) |
| `gitea-policy.yaml` | sandbox network egress policy for agent binaries |
| `.gitea/workflows/` | working copy of the agent workflows |

## Useful commands

```bash
# Stack
docker compose ps
docker compose logs -f <server|db|runner|agent-runner>
docker compose up -d <service>        # recreates — REQUIRED after env/config changes
docker compose down

# Images
docker build -t agent-sandbox:base agent-sandbox
docker build -t agent-sandbox:pi agent-sandbox/pi
docker build -t agent-sandbox:opencode agent-sandbox/opencode
docker run --rm --entrypoint sh agent-sandbox:pi -c '<smoke test>'

# Database (Gitea internals)
docker exec -it gitea-db-1 psql -U USER -d gitea
#   interesting tables: action_runner, action_run (status: 1=success 2=failure
#   3=cancelled 4=skipped 5=waiting 6=running), action_task, user, repository

# Gitea CLI — run directly as git; `su` does NOT work inside the container
docker exec -u git gitea gitea admin user create --username X --email X@localhost --password P
docker exec -u git gitea gitea admin user generate-access-token --username X --token-name N --scopes all --raw

# Gitea API (tokens in .env)
curl -s -H "Authorization: token $ADMIN_TOKEN" http://localhost:3000/api/v1/repos/owner/<repo>
```

## Gotchas (learned the hard way)

- **Runner env changes need `docker compose up -d <service>`** (recreate), not
  `docker restart`. `config.yaml` `${VAR}` expansion uses the runner *process*
  env, which only compose can provide.
- **Gitea 1.27 has NO workflow-level `if:`** — a matching event always creates
  a run. Gate at job/step level; split trigger events to avoid ghost runs
  (e.g. review comments on regular issues).
- **Job envs come from the runner's `envs:`** — everything in
  `runner-agent/config.yaml` lands in every job container.
- **Agent attribution**: jobs set `git config user.email bot@localhost` and an
  authenticated remote (`bot:AGENT_TOKEN@…`), so commits/PRs/comments show up
  as the `bot` user. Don't break the "Configure bot identity" step.
- **Loop prevention** is the `<!-- via:agent -->` marker (posted by
  `post-comment.sh`, checked in every `if:`). Don't remove it from either side.
- **Bot posts as `bot`**, but older comments may be from `owner` — don't
  write actor-based logic; use the marker.
- **pi 0.74.2 does not interpolate env vars in `apiKey`** despite the docs —
  the key must be baked into `models.json` at image build time.
- **`gitea.head_ref` is empty for `issue_comment` events** — agents fetch the
  PR head ref via the API (`/pulls/{n}` → `.head.ref`) instead.
- **User-controlled content in shell**: always pass it via env vars +
  `printf '%s\n'` / quoted heredocs, never unquoted interpolation of comment
  bodies.
- **Repo creation via API needs `write:user` scope** — use `ADMIN_TOKEN`, not
  `GITEA_TOKEN`.
- **Update a repo via API with PATCH** (PUT on `/repos/{owner}/{name}` is 405).
- **Newer git defaults to `master`** — push with `git push origin master:main`
  if the target repo uses `main`.

## Verification after changes

| Changed | Verify with |
|---|---|
| compose / `.env` | `docker compose config -q` + recreate the service + `docker exec <container> printenv VAR` |
| runner `config.yaml` | recreate service, `docker exec gitea-agent-runner printenv AGENT_TOKEN` |
| agent image | rebuild, `docker run --rm --entrypoint sh agent-sandbox:<a> -c '<agent> --version'` |
| workflow | YAML-parse it; actual trigger test = post a `@pi`/`@opencode` comment on a throwaway issue |
