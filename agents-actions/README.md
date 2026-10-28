# agents-actions

Template repo for AI-agent-managed Gitea repositories.

## How it works

Agent tasks are dispatched by **2pizzas** (a webhook-driven service in the
`2pizzas-dev` infra repo), NOT by per-repo workflow files. This template
repo is README-only — it exists so that new repos can be created from it and
immediately recognized by the 2pizzas dispatcher.

To make a repo agent-managed:

1. Append `owner/repo` to `AGENTD_REPOS` in the infra repo's `.env`
2. Run `./seed.sh` (adds `bot` as write collaborator; the global webhook
   covers all repos — no per-repo webhook needed)
3. `docker compose up -d 2pizzas`

After that, `@pi` / `@opencode` comments on issues and PRs in this repo
trigger agent tasks.

## Usage

- `@pi fix the flaky test` — on an issue or a PR conversation comment
- `@opencode add a changelog entry` — same, with opencode instead
- Inline review comment on a PR diff: `@pi please extract that into a helper`

The agent acts as the `bot` user, so its commits, branches, PRs and comments
show up under `bot` and can be reviewed like a regular contribution.

## Requirements

1. **`bot` as write collaborator on the repo** — per-repo, one time:
   - UI: *Settings → Collaborators → add `bot` (write)*, or
   - API: `PUT /repos/{owner}/{repo}/collaborators/bot` with body `{"permission":"write"}`
2. **Default branch is `main`** — the prompts tell the agent to open PRs
   against `main`. If your repo uses a different default branch, update the
   2pizzas prompt template.
