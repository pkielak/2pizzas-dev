import { execFile } from 'node:child_process';
import { CFG } from './config.mjs';

// running container names (null if docker is unreachable)
export async function dockerNames() {
  try {
    const out = await execFileP('docker', ['ps', '--format', '{{.Names}}'], { timeout: 8000 });
    return new Set(out.trim().split('\n').filter(Boolean));
  } catch { return null; }
}

// gh-pages sites (pages/ service instances): PAGES_SITES entries are
// repo:port:container[:https_port] — the deployed commit is read from the
// container's synced checkout; the optional 4th field is the host TLS port
// (surfaces an https link in the UI when set)
export async function pagesStatus() {
  return Promise.all(CFG.pagesSites.map(async (s) => {
    const [repo, port, container, httpsPort] = s.split(':');
    let commit = null, err = null;
    try {
      const out = (await execFileP('docker', ['exec', container, 'git', '-C', '/srv/pages', 'log', '-1', '--format=%h|%cI|%s'])).trim();
      const [h, at, ...rest] = out.split('|');
      commit = { h, at, s: rest.join('|') };
    } catch (e) { err = e.message; }
    // https_port: the 4th PAGES_SITES field is an optional OVERRIDE. When
    // absent, auto-detect from the 8443 host-port mapping alone — the TLS
    // port is static compose config, so the https link is always visible
    // for a TLS-ready service (the user asked for it, not hidden behind
    // live-TLS detection). The link goes live once a real cert pair is in
    // pages/certs/ + the service is recreated — no PAGES_SITES edit.
    let https_port = httpsPort || null;
    if (!https_port && container) {
      try {
        const raw = (await execFileP('docker', ['inspect', '-f',
          '{{range $p, $n := .NetworkSettings.Ports}}{{if eq $p "8443/tcp"}}{{$n[0].HostPort}}{{end}}{{end}}',
          container])).trim();
        if (/^\d+$/.test(raw)) https_port = raw;
      } catch { /* no 8443 mapping, or container down → http-only */ }
    }
    return { repo, port, container, https_port, commit, err };
  }));
}

export function execFileP(cmd, args, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
}
