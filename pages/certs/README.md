# TLS material for the pages services

Drop a **real (CA-signed)** `cert.pem` + `key.pem` here to enable HTTPS on
the pages compose services (the 8443 nginx listener). The directory itself
is tracked so it is easy to find; the `*.pem` files are gitignored
(per-machine secrets).

- `cert.pem` — leaf certificate (PEM)
- `key.pem` — private key (PEM, `chmod 600`)

The entrypoint wires in the 8443 TLS block **only** when both files exist;
without them the services run HTTP-only.

**Tailnet cert** (recommended): issue one for the machine's magic-DNS name
(e.g. `hapek.tail7e5928.ts.net`), split it into `cert.pem` + `key.pem` here,
and recreate the services. It's trusted by browsers, so
`https://<name>:3443/` works with no warning.

**After dropping/changing certs:**

```sh
docker compose up -d pages            # and any other pages services
```

No `PAGES_SITES` edit needed — the 2pizzas UI (`/pages` + home) renders the
https link for any service that maps its 8443 TLS port; it goes live once
the cert is in place. The optional 4th `PAGES_SITES` field
(`…:https_port`) remains as a manual override.
