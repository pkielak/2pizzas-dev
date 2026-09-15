# agents-actions

Gitea Actions workflows for AI agent assist: post a comment on an issue or PR
mentioning **`@pi`** or **`@opencode`** and the corresponding agent picks up the
work — implements the request, pushes commits / opens PRs, and replies with a
summary. Inline review comments on PRs work the same way.

## Usage

- `@pi fix the flaky test` — on an issue or a PR conversation comment
- `@opencode add a changelog entry` — same, with opencode instead
- Inline review comment on a PR diff: `@pi please extract that into a helper`

The agent acts as the `bot` user, so its commits, branches, PRs and comments
show up under `bot` and can be reviewed like a regular contribution.

## Requirements

1. **Runner labels** — a Gitea Actions runner must be registered with the
   labels `agent-pi` and `agent-opencode`, mapped to the `agent-sandbox:pi` /
   `agent-sandbox:opencode` images (see the `gitea-with-agents` repo for the
   full runner + image setup).
2. **`AGENT_TOKEN` in the runner envs** — an API token of the `bot` user,
   injected into jobs via the runner config `envs:`:
   ```yaml
   runner:
     envs:
       AGENT_TOKEN: "${AGENT_TOKEN}"
   ```
3. **`bot` as write collaborator on the repo** — per-repo, one time:
   - UI: *Settings → Collaborators → add `bot` (write)*, or
   - API: `PUT /repos/{owner}/{repo}/collaborators/bot` with body `{"permission":"write"}`
4. **Default branch is `main`** — the prompts tell the agent to open PRs
   against `main`. If your repo uses a different default branch, edit the
   `"base": "main"` string in `comment-assist.yaml`.

## How it works

| File | Purpose |
|---|---|
| `comment-assist.yaml` | `issue_comment` (issues *and* PR conversations) → jobs `assist-pi` / `assist-opencode` |
| `pr-review.yml` | `pull_request_review_comment` (inline diff comments) → jobs `review-pi` / `review-opencode` |
| `post-comment.sh` | posts the agent's reply via the API and stamps it `<!-- via:agent -->` |
| `output_filter.jq` | filters pi's JSON stream output into readable log text |

- Jobs are gated by mention (`contains(body, '@pi')` / `'@opencode'`), so a
  comment without a mention runs nothing.
- Reply loop prevention: the agent's replies carry the `<!-- via:agent -->`
  marker, and both workflows' `if:` exclude comments containing it.
- Each agent runs in its own container image (`runs-on: agent-pi` /
  `agent-opencode`); `@pi and @opencode` in one comment runs both in parallel.
