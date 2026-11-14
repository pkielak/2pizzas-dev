# pages

Static site server — a stand-in for Gitea Pages (which Gitea 1.27 lacks).
Each instance is a compose service that polls a repo's `gh-pages` branch
(a CI workflow in the target repo builds the app and pushes the branch)
and nginx-serves it on a fixed port, refreshing every ~60s.

## Files

```
Dockerfile      alpine + git + nginx
nginx.conf      serves /srv/pages
entrypoint.sh  clone-or-pull loop on the gh-pages branch
certs/          (gitignored) per-site TLS material, if used
```

## Configuration

`PAGES_SITES` in `.env` lists the sites 2pizzas shows on its `/pages`
dashboard: `repo:port:container` per `pages` compose service
(e.g. `owner/my-repo:3002:gitea-pages`).

Add a site: new compose service (see `browser-llm-bench-pages` in
`docker-compose.yml`) → append `repo:port:container` to `PAGES_SITES` →
`docker compose up -d 2pizzas`.
