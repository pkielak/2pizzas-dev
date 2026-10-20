import fs from 'node:fs';
import path from 'node:path';
import { CFG } from './config.mjs';
import { execFileP } from './util.mjs';

// ── Gitea theme mirroring ────────────────────────────────────────────────────
// The UI is styled with Gitea's own CSS variables so it always matches the
// operator's configured Gitea theme. Gitea's theme CSS files are content-hashed
// and the name→file map is embedded in the gitea binary, so we discover it at
// runtime (docker exec grep), fetch the file for the configured theme, and
// serve it same-origin at /assets/gitea-theme.css. Cached 10 min. If anything
// fails the page falls back to the hardcoded dark palette (var() fallbacks).
let themeState = { at: 0, theme: 'gitea-auto', css: '' };
let themeRefresh = null;

const THEME_TTL = 10 * 60_000;
const themeFile = path.join(CFG.dataDir, 'theme.json');
const giteaOrigin = () => new URL(CFG.giteaApi).origin;

// Full discovery pass. SLOW (~15s — grepping the ~100MB gitea binary), so it
// always runs in the background; requests serve whatever themeState already has.
// Results persist to theme.json so restarts render the right theme instantly.
async function refreshTheme() {
  let theme = 'gitea-auto';
  try {
    // Gitea 1.27's user API does NOT expose the theme field → read it from the DB
    // via the docker socket (psql on the db container, local socket = no password).
    const safeUser = CFG.themeUser.replace(/[^a-z0-9-]/gi, '');
    const out = await execFileP('docker', ['exec', CFG.giteaDbContainer, 'psql', '-U', CFG.giteaDbUser, '-d', CFG.giteaDbName, '-tAc',
      `SELECT theme FROM "user" WHERE lower_name='${safeUser}'`]);
    const v = out.trim();
    if (v) theme = v.startsWith('gitea-') ? v : `gitea-${v}`;
  } catch { /* db unreachable: keep auto */ }
  let file = null;
  try {
    // theme name → content-hashed css filename is embedded in the gitea binary
    const out = await execFileP('docker', ['exec', CFG.giteaContainer, 'grep', '-ao', 'theme-[a-z-]*\\.[A-Za-z0-9_-]*\\.css', '/app/gitea/gitea'], { timeout: 30_000 });
    // exact match: filename `theme-<name>.<hash>.css` (the dot excludes -protanopia/-tritanopia variants)
    for (const m of out.matchAll(/theme-[a-z-]*\.[A-Za-z0-9_-]*\.css/g)) {
      if (m[0].startsWith(`theme-${theme}.`)) { file = m[0]; break; }
    }
  } catch { /* binary not greppable */ }
  if (!file) {
    try { // fallback: whatever the anonymous homepage renders (default theme)
      const home = await (await fetch(giteaOrigin(), { signal: AbortSignal.timeout(4000) })).text();
      const m = home.match(/href="(\/assets\/css\/theme-[^"]+\.css)"/);
      if (m) file = m[1].slice(1);
    } catch { /* no file */ }
  }
  file = file?.replace(/^assets\/css\//, ''); // normalize (homepage fallback returns a full path)
  let css = '';
  if (file) {
    try {
      const res = await fetch(`${giteaOrigin()}/assets/css/${file}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) css = await res.text();
    } catch { /* keep empty */ }
  }
  themeState = { at: Date.now(), theme, css };
  try { fs.writeFileSync(themeFile, JSON.stringify({ theme, file, css, at: themeState.at })); } catch { /* non-fatal */ }
  console.log(`[theme] ${theme} via ${file || '(fallback palette)'}${css ? ` (${(css.length / 1024).toFixed(1)}KB)` : ''}`);
}

// Sync: return the current theme immediately; kick a background refresh if stale.
export function giteaTheme() {
  if (!themeRefresh && Date.now() - themeState.at >= THEME_TTL) kickThemeRefresh();
  return themeState;
}

function kickThemeRefresh() {
  if (themeRefresh) return;
  themeRefresh = refreshTheme()
    .catch((e) => console.log(`[theme] refresh failed: ${e.message}`))
    .finally(() => { themeRefresh = null; });
}

// First paint: load the persisted theme, then verify in the background.
try {
  const saved = JSON.parse(fs.readFileSync(themeFile, 'utf8'));
  if (saved?.css && Date.now() - saved.at < 24 * 3600_000) {
    themeState = { at: saved.at, theme: saved.theme || 'gitea-auto', css: saved.css };
    console.log(`[theme] loaded from cache: ${themeState.theme}`);
  }
} catch { /* no cache yet */ }
kickThemeRefresh();
