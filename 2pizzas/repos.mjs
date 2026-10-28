import { CFG } from './config.mjs';
import { db } from './db.mjs';

// ── managed repos: env seed list ∪ self-enrolled (db) ───────────────────────
// The @agent mention on an unmanaged repo IS the opt-in: enroll() persists
// the repo and grants the agent users access, then the task proceeds as usual.
export const dbRepos = () => db.prepare("SELECT owner || '/' || name AS repo FROM managed_repos").all().map((r) => r.repo);
export const managedRepos = () => [...new Set([...CFG.repos, ...dbRepos()])];
export const isManaged = (repo) => managedRepos().includes(repo);

// per-repo collaborator grants: work agents write (clone/push/PR/comment),
// the reviewer reads (clone only — its token is read-scoped anyway)
const GRANTS = [
  ...Object.values(CFG.agents).map((a) => [a.login, 'write']),
  [CFG.review.login, 'read'],
];

async function grantRepo(repo) {
  for (const [login, role] of GRANTS) {
    const res = await fetch(`${CFG.giteaApi}/repos/${repo}/collaborators/${login}`, {
      method: 'PUT',
      headers: { Authorization: `token ${CFG.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role, permission: role }),
    });
    if (!res.ok) throw new Error(`PUT collaborators ${login} → ${res.status}`);
  }
}

export async function enroll(repo) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`bad repo name ${repo}`);
  db.prepare('INSERT OR IGNORE INTO managed_repos (owner, name) VALUES (?, ?)').run(owner, name);
  // the agents must be collaborators: they clone, commit and comment as
  // their own users (same grants seed.sh makes for env-listed repos)
  await grantRepo(repo);
  console.log(`[enroll] ${repo} self-enrolled (agent collaborators granted)`);
}

// startup: re-verify grants on every managed repo — new agent users on
// migrated instances, env-list edits and repos added while 2pizzas was down
for (const repo of managedRepos())
  grantRepo(repo).catch((e) => console.error(`[repos] ${repo}: ${e.message}`));
