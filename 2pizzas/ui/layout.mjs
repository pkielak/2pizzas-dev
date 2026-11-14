// Theme CSS + the dark-mode boot script — shared by the 401 unlock form
// (the last server-rendered page) and mirrored 1:1 into the SPA
// (src/theme.css). Everything else (page shell, LIVE_SCRIPT, __pageInit,
// esc/ctxLine/fmtTok helpers) died with the SPA migration.

export const THEME_CSS = `:root{
  --crust:#181818;--charcoal:#121212;--dark:#000000;--light:#f5f5f5;--sauce:#dd4a48;--cheese:#eeddb2;--olives:#4e8752;
  --sauce-dark:#b93a38;--olives-dark:#3d6b41;--ham:#d17a66;
  /* semantic — light mode */
  --bg:#f5f5f5;--surface:#fff;--ink:#121212;--muted:#555;--muted-2:#666;--faint:#999;
  --line:#000;--shadow:#000;--track:#e2e2e2;
  --cheese:#eeddb2;--cheese-ink:var(--charcoal);
  --nav-active-bg:var(--charcoal);--nav-active-ink:var(--light);
  /* legacy --color-* aliases (point at the semantic set → follow dark mode) */
  --color-body:var(--bg);
  --color-text:var(--ink);
  --color-text-2:#444;
  --color-text-3:var(--muted-2);
  --color-text-light-2:var(--muted);
  --color-text-light-3:var(--muted-2);
  --color-text-light-4:var(--faint);
  --color-primary:var(--sauce);
  --color-primary-light-1:#e8716f;
  --color-primary-light-2:#e8716f;
  --color-success-text:var(--olives);
  --color-warning-text:#9a6b2f;
  --color-error-text:var(--sauce);
  --color-light-border:var(--line);
  --color-nav-bg:var(--bg);
  --color-nav-text:var(--ink);
  --color-overlay-backdrop:rgba(0,0,0,.55);
  --color-secondary-alpha-10:var(--surface);
  --color-secondary-alpha-20:#eee;
  --color-hover:var(--cheese);
  --color-console-bg:#121212;
  --color-console-fg:#eaeaea;
  --color-console-border:var(--line);
  --color-input-background:var(--surface);
  --color-input-border:var(--line);
  --color-input-text:var(--ink);
  --color-button-secondary-background:var(--surface);
  --color-button-secondary-border:var(--line);
  --color-button-secondary-text:var(--ink);
  --color-button-primary-background:var(--sauce);
  --color-button-primary-text:#fff;
}
html[data-theme=dark]{
  --bg:var(--crust);--surface:#1c1c1c;--ink:#f5f5f5;--muted:#b0b0b0;--muted-2:#8a8a8a;--faint:#666;
  --line:#f5f5f5;--shadow:#666;--track:#2a2a2a;
  --cheese:#eeddb2;--cheese-ink:var(--charcoal);
  --nav-active-bg:var(--cheese);--nav-active-ink:var(--cheese-ink);
  --color-text-2:#ccc;
  --color-secondary-alpha-20:#222;
  --color-console-bg:#000;
}`;

// pre-paint theme apply — runs in <head> before the body parses, so the
// saved dark theme is on <html> before first paint (no light flash).
// Toggle lives on /settings (persisted in localStorage).
export const THEME_SCRIPT = `<script>try{if(localStorage.getItem('tea_theme')==='dark')document.documentElement.dataset.theme='dark'}catch(e){}</script>`;
