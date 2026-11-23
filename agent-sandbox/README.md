# agent-sandbox

The Gitea agent job images. 2pizzas runs every agent task as a one-shot
`docker run --rm --runtime=runsc agent-sandbox:<agent>` container (gVisor
sandboxed); the `review` variant has a special boundary — see below.

## Image tree

```
Dockerfile            agent-sandbox:base — ubuntu 24.04, node 22, git, jq, tea CLI,
                        gitleaks, semgrep (rule packs baked as local configs in
                        /etc/semgrep so the sandbox needs no registry egress)
├── pi/               agent-sandbox:pi       — pi coding agent (pinned version)
│   └── pi-settings/  models.json + settings.json — BAKED AT BUILD TIME
├── opencode/         agent-sandbox:opencode — opencode agent
│   └── opencode-config/  opencode.json — BAKED AT BUILD TIME
├── review/           agent-sandbox:review   — opencode + baked code-review skill
└── ops/              agent-sandbox:ops      — pi + docker-cli (parked; see root AGENTS.md)
```

## Key properties

- **Model config is baked.** `models.json` / `opencode.json` are generated from
  `inference.json` by `./setup.sh` and COPY'd in. They contain API keys, so
  they're gitignored (`.example` committed). After changing the model set:
  `./setup.sh --rebuild`. The Dockerfiles fail the build if the real file is
  missing (see root AGENTS.md, "example-file pattern").
- **`review` is read-only by token, not by prompt.** It clones with
  `REVIEW_TOKEN` (read scope) and never receives the write token — it
  physically cannot push or post. 2pizzas posts the review comment itself.
- **Deterministic scanners** (gitleaks, semgrep) run in the `security-scan.yaml`
  CI workflow and inside the reviewer's `code-review` skill.

## Build

```bash
docker build -t agent-sandbox:base agent-sandbox
docker build -t agent-sandbox:pi agent-sandbox/pi
docker build -t agent-sandbox:opencode agent-sandbox/opencode
docker build -t agent-sandbox:review agent-sandbox/review
# smoke test
docker run --rm --entrypoint sh agent-sandbox:pi -c 'pi --version'
```

Or just `./setup.sh` (builds all of them). Details: root `AGENTS.md`.
