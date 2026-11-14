# 2pizzas — webhook-driven agent dispatcher (replaces the Gitea Actions
# agent workflows). See server.mjs. Needs the docker CLI to spawn the
# sandboxed agent job containers via the host socket.

# ── Svelte UI build (vite — see vite.config.mjs) ─────────────────
# npm ci needs the lockfile; .dockerignore keeps node_modules out of the
# context, and the built dist is carried over from THIS stage (the host's
# ui/dist, if any, is ignored).
FROM node:22-alpine AS ui
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . ./
RUN npm run build

# ── runtime ───────────────────────────────────────────────────────
FROM node:22-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app
COPY . ./
COPY --from=ui /app/ui/dist ./ui/dist
RUN mkdir -p /data/work /data/logs

VOLUME /data
EXPOSE 3001
CMD ["node", "server.mjs"]
