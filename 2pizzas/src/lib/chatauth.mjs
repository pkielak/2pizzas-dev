// Token carrier fallback for chat endpoints (the session cookie is primary;
// this covers cookie-blocked browsers) — URL param, else the localStorage
// saved token. EventSource cannot set headers, so the stream URL carries it
// as a query param (the server's chatAuthed accepts ?token=).
export const chatToken = () =>
  new URLSearchParams(location.search).get('token') || localStorage.getItem('tea_chat_token') || '';

export const authUrl = (p) => p + (chatToken() ? '?token=' + encodeURIComponent(chatToken()) : '');
