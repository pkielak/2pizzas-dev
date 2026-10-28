// Global SSE broadcast channel for UI live updates.
//
// Replaces the old 3s full-page auto-reload: dashboard pages subscribe to
// /live/stream and swap their <main> content in place when something
// changes, so the browser never reloads (no tab-spinner pulsing, no
// flicker). Events are coarse on purpose:
//   tasks  — a task was enqueued or changed status (queue.mjs, tasks.mjs)
//   chat   — a chat session was created/killed (chat.mjs)
//   tick   — 30s heartbeat for slow-changing sections (android runs, pages,
//            docker status, infra diagram)
const clients = new Set();

export const liveBroadcast = (what) => {
  if (!clients.size) return;
  const frame = `data: ${what}\n\n`;
  for (const res of [...clients]) {
    try { res.write(frame); }
    catch { clients.delete(res); }
  }
};

export const liveAdd = (res) => { clients.add(res); };
export const liveRemove = (res) => { clients.delete(res); };

setInterval(() => liveBroadcast('tick'), 30_000).unref?.();
