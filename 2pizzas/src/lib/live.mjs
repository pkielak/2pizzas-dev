import { writable } from 'svelte/store';

// Single app-wide subscription to /live/stream (server: 2pizzas/live.mjs).
// The old design re-fetched the page HTML and swapped <main> innerHTML on
// every event; here pages subscribe to `live` and refetch their OWN JSON —
// fine-grained updates, no DOM surgery, focus/scroll preserved.
export const live = writable(0);

let es = null;
export const connectLive = () => {
  if (es) return;
  es = new EventSource('/live/stream');
  es.onmessage = () => live.set(Date.now());
};
