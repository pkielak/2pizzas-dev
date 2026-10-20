import { CFG } from './config.mjs';
import { db } from './db.mjs';

// ── managed repos: env seed list ∪ self-enrolled (db) ───────────────────────
// The @agent mention on an unmanaged repo IS the opt-in: enroll() persists
// the repo and grants the bot write access, then the task proceeds as usual.
export const dbRepos = () => db.prepare("SELECT owner || '/' || name AS repo FROM managed_repos").all().map((r) => r.repo);
export const managedRepos = () => [...new Set([...CFG.repos, ...dbRepos()])];
export const isManaged = (repo) => managedRepos().includes(repo);

export async function enroll(repo) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`bad repo name ${repo}`);
  db.prepare('INSERT OR IGNORE INTO managed_repos (owner, name) VALUES (?, ?)').run(owner, name);
  // bot must be a write collaborator: it clones, commits and comments as bot
  // (same call seed.sh makes for env-listed repos)
  const res = await fetch(`${CFG.giteaApi}/repos/${repo}/collaborators/${CFG.botLogin}`, {
    method: 'PUT',
    headers: { Authorization: `token ${CFG.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'write', permission: 'write' }),
  });
  if (!res.ok) throw new Error(`PUT collaborators → ${res.status}`);
  console.log(`[enroll] ${repo} self-enrolled (bot granted write access)`);
}
