import { writable } from 'svelte/store';
import Stats from '../pages/Stats.svelte';
import Tasks from '../pages/Tasks.svelte';
import TaskDetail from '../pages/TaskDetail.svelte';

// SPA routes. Everything else in the nav is a plain anchor → full load of
// the server-rendered page (ui/*.mjs) until it migrates. The server mirrors
// this list in SPA_ROUTES (server.mjs) — keep the two in sync.
const routes = [
  { re: /^\/stats$/, component: Stats, title: () => 'stats' },
  { re: /^\/tasks$/, component: Tasks, title: () => 'tasks' },
  {
    re: /^\/task\/(\d+)$/,
    component: TaskDetail,
    title: (m) => `task ${m[1]}`,
    props: (m) => ({ taskId: +m[1] }),
  },
];

export const resolve = (p) => {
  for (const r of routes) {
    const m = p.match(r.re);
    if (m) return { component: r.component, title: r.title(m), props: r.props ? r.props(m) : {} };
  }
  return null;
};

export const currentRoute = writable(resolve(location.pathname));

// true if `href` is an SPA route (navigated in place); false → let the
// default anchor navigation happen (full load of the server page)
export const navigate = (href) => {
  const r = resolve(href);
  if (!r) return false;
  history.pushState({}, '', href);
  currentRoute.set(r);
  return true;
};

addEventListener('popstate', () => currentRoute.set(resolve(location.pathname)));
