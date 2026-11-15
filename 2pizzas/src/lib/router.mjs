import { writable } from 'svelte/store';
import Stats from '../pages/Stats.svelte';
import Tasks from '../pages/Tasks.svelte';
import TaskDetail from '../pages/TaskDetail.svelte';
import ChatList from '../pages/ChatList.svelte';
import ChatView from '../pages/ChatView.svelte';
import ChatHistory from '../pages/ChatHistory.svelte';
import Backends from '../pages/Backends.svelte';
import Settings from '../pages/Settings.svelte';
import Repos from '../pages/Repos.svelte';
import Android from '../pages/Android.svelte';
import Pages from '../pages/Pages.svelte';
import Infra from '../pages/Infra.svelte';
import Home from '../pages/Home.svelte';

// SPA routes — every nav route. The server mirrors this list in SPA_ROUTES
// (server.mjs) — keep the two in sync. `nav` is the sidebar highlight key
// (defaults to the title); `app` = full-height chat layout.
const routes = [
  { re: /^\/stats$/, component: Stats, title: () => 'stats' },
  { re: /^\/backends$/, component: Backends, title: () => 'backends' },
  { re: /^\/settings$/, component: Settings, title: () => 'settings' },
  { re: /^\/repos$/, component: Repos, title: () => 'repos' },
  { re: /^\/android$/, component: Android, title: () => 'android' },
  { re: /^\/pages$/, component: Pages, title: () => 'pages' },
  { re: /^\/infra$/, component: Infra, title: () => 'infra' },
  { re: /^\/$/, component: Home, title: () => 'home' },
  { re: /^\/tasks$/, component: Tasks, title: () => 'tasks' },
  {
    re: /^\/task\/(\d+)$/,
    component: TaskDetail,
    title: (m) => `task ${m[1]}`,
    props: (m) => ({ taskId: +m[1] }),
  },
  // the LIST page uses the normal scrolling layout (no app) — only the
  // session views pin input/messages full-height
  { re: /^\/chat$/, component: ChatList, title: () => 'chat', nav: 'chat' },
  {
    re: /^\/chat\/(\d+)$/,
    component: ChatView,
    title: (m) => `chat ${m[1]}`,
    nav: 'chat',
    app: true,
    props: (m) => ({ sessionId: +m[1] }),
  },
  {
    re: /^\/chat\/r(\d+)$/,
    component: ChatHistory,
    title: (m) => `chat ${m[1]} (ended)`,
    nav: 'chat',
    app: true,
    props: (m) => ({ rowid: +m[1] }),
  },
];

export const resolve = (p) => {
  for (const r of routes) {
    const m = p.match(r.re);
    if (m) return { component: r.component, title: r.title(m), nav: r.nav ?? r.title(m), app: r.app, props: r.props ? r.props(m) : {} };
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
