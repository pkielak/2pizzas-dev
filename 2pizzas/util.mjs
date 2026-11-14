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
// repo:port:container — the deployed commit is read from the container's
// synced checkout
export async function pagesStatus() {
  return Promise.all(CFG.pagesSites.map(async (s) => {
    const [repo, port, container] = s.split(':');
    let commit = null, err = null;
    try {
      const out = (await execFileP('docker', ['exec', container, 'git', '-C', '/srv/pages', 'log', '-1', '--format=%h|%cI|%s'])).trim();
      const [h, at, ...rest] = out.split('|');
      commit = { h, at, s: rest.join('|') };
    } catch (e) { err = e.message; }
    return { repo, port, container, commit, err };
  }));
}

export function execFileP(cmd, args, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
}
