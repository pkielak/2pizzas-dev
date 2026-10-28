// Event kick for the task pump. The pump runs on a 2s safety-net interval,
// but enqueue/completion should start the next task IMMEDIATELY. A tiny
// indirection module (instead of queue.mjs importing pump from tasks.mjs)
// keeps the import graph acyclic: tasks.mjs registers itself via setKick().
let fn = null;
export const setKick = (f) => { fn = f; };
export const kick = () => { fn?.(); };
