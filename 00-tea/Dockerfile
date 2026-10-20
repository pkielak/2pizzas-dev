# 00-tea — webhook-driven agent dispatcher (replaces the Gitea Actions
# agent workflows). See server.mjs. Needs the docker CLI to spawn the
# sandboxed agent job containers via the host socket.
FROM node:22-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app
COPY . ./
RUN mkdir -p /data/work /data/logs

VOLUME /data
EXPOSE 3001
CMD ["node", "server.mjs"]
