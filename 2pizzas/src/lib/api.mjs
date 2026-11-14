export async function getJson(url) {
  const r = await fetch(url);
  // 401 = the server's unlock form is served AT this URL — show it
  if (r.status === 401) { location.href = url; throw new Error('auth required'); }
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

export async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { location.href = url; throw new Error('auth required'); }
  if (!r.ok) {
    let msg = `${url} → ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* keep status msg */ }
    throw new Error(msg);
  }
  return r.json();
}
