# 2pizzas

The webhook-driven AI agent dispatcher + dashboard. Gitea mention
(`@pi`/`@opencode`) → sqlite queue → one-shot gVisor-sandboxed agent
container → reply posted back. Also hosts the dashboard UI, the agent chat,
and the inference backend registry.

The root `AGENTS.md` is the authoritative deep-dive (queue semantics, review
chain, loop prevention, gotchas). This file is the map.

## Server (`server.mjs`)

A thin HTTP router — all logic lives in sibling modules:

| Module | Role |
|---|---|
| `config.mjs` | env config (`CFG`), host-local detection |
| `db.mjs` | sqlite (task queue, chat sessions, deliveries) |
| `gitea.mjs` | Gitea API (per-user tokens), `androidRuns` |
| `repos.mjs` | managed repos + self-enrollment |
| `inference.mjs` | backend registry (`inference.json`), model pick, bake-sync check |
| `webhook.mjs` / `poll.mjs` | global webhook intake (deduped) + 60s fallback poll |
| `queue.mjs` | enqueue + review/rework chain |
| `kick.mjs` | pump kick indirection (keeps the import graph acyclic) |
| `tasks.mjs` | runsc job runner, log pump, afterTask, failure triage |
| `chat.mjs` | long-lived pi RPC chat containers |
| `live.mjs` | the `/live/stream` SSE feed (one global feed for the UI) |
| `redact.mjs` | scrubs all 2pizzas-held secrets from log lines |
| `theme.mjs` | mirrors the configured Gitea theme into the UI |
| `ui/layout.mjs` | theme CSS + the 401 unlock form (last server-rendered page) |
| `ui/stats.mjs` | `/api/stats` data |

Side-effect imports (`pump`/`poll` intervals, theme discovery, chat reaper)
run at module load. The import graph is acyclic.

## UI (`src/` — Svelte 5 SPA, Vite)

Every page is a Svelte component (`src/pages/`), built by Vite into `ui/dist`
and served by `server.mjs` under `/ui/*`; the SPA routes are mirrored
server-side in `SPA_ROUTES`. One global `EventSource('/live/stream')`
(`src/lib/live.mjs`) drives all live updates — pages refetch their own JSON
on events (focus-safe, no HTML swaps). The 401 unlock form is the only
server-rendered page.

```bash
npm install
npm run dev      # vite dev server, proxies /api + /live to :3001
npm run build    # → ui/dist (also built inside the Docker image)
```

## API (all token-gated, see root AGENTS.md)

```
GET  /api/tasks · /api/task/<id> · /api/task/<id>/log · /api/task/<id>/stream (SSE)
GET  /api/stats
GET  /api/chat · /api/chat/sessions · /api/chat/repos · /api/chat/<id>/history
POST /api/chat · /api/chat/<id>/message · /api/chat/<id>/abort · /api/chat/grant
DELETE /api/chat/<id>
GET  /api/backends · /api/backends/full · /api/backends/:id/test
POST /api/backends · PATCH/DELETE /api/backends/:id · /api/backends/:id/up|down · /api/backends/test
GET  /api/repos · DELETE /api/repos/<owner/name>
GET  /api/android · /api/pages · /api/infra
GET  /live/stream (SSE) · /healthz
```

## TUI

`tui.mjs` — zero-dependency terminal UI over the same API, for SSH sessions:

```bash
node 2pizzas/tui.mjs    # env: PIZZAS_URL, UI_TOKEN (remote only)
```

## Docker

Multi-stage: Vite builds the UI, runtime is node + docker-cli (2pizzas talks
to the host docker daemon to launch the job containers).

```bash
docker compose build 2pizzas && docker compose up -d 2pizzas
```
