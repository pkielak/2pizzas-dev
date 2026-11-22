# pages

Static site server — a stand-in for Gitea Pages (which Gitea 1.27 lacks).
Each instance is a compose service that polls a repo's `gh-pages` branch
(a CI workflow in the target repo builds the app and pushes the branch)
and nginx-serves it on a fixed port, refreshing every ~60s.

## Files

```
Dockerfile      alpine + git + nginx
nginx.conf      base http config (8080) + an include for the optional TLS block
nginx-ssl.conf    the 8443 ssl server block (wired in only when certs exist)
entrypoint.sh     clone-or-pull loop + assembles the final nginx config
certs/            TLS material — drop a real cert.pem + key.pem here (pems
                  gitignored, the dir's README is tracked)
```

## Configuration

`PAGES_SITES` in `.env` lists the sites 2pizzas shows on its `/pages`
dashboard: `repo:port:container[:https_port]` per `pages` compose service
(e.g. `owner/my-repo:3002:gitea-pages`, or
`owner/my-repo:3002:gitea-pages:3443` to also surface an https link).

Add a site: new compose service (see `browser-llm-bench-pages` in
`docker-compose.yml`) → append `repo:port:container` to `PAGES_SITES` →
`docker compose up -d 2pizzas`.

## HTTPS (opt-in — HTTP-only is the default)

Each service already maps a TLS port (`3443:8443` on `pages`, `3444:8443` on
`browser-llm-bench-pages`) and mounts `./pages/certs:/etc/nginx/certs:ro`.
The 8443 server block is only loaded when a real cert pair is present, so
with no certs the service runs HTTP-only and nginx always starts.

**Real (CA-signed) cert** — the only supported path. Drop `cert.pem` +
`key.pem` into `pages/certs/` (see the README in that dir), then recreate
the service (`docker compose up -d <service>`). A Tailscale tailnet cert
for the machine's magic-DNS name (e.g. `hapek.tail7e5928.ts.net`) is the
right fit: it's trusted by browsers, so `https://<name>:3443/` works with
no warning. The 2pizzas UI (`/pages` + home) renders the https link for any
service that maps its 8443 TLS port — the link is always visible and goes
live once the cert is in place (**no `PAGES_SITES` edit needed**).

Self-signed certs are intentionally not generated here: a self-signed pair
is never trusted for the tailnet hostname (the browser warns), so it can't
give a clean https experience.

The optional 4th `https_port` field in `PAGES_SITES` (`…:3443`) remains as
a manual override of the auto-detected host TLS port.
