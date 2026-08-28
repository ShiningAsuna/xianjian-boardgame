// 极简 fetch 封装：统一带 token、抛出后端错误文本
const TOKEN_KEY = 'xj_auth';

export function loadAuth() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY)) || null;
  } catch {
    return null;
  }
}

export function saveAuth(auth) {
  if (auth) localStorage.setItem(TOKEN_KEY, JSON.stringify(auth));
  else localStorage.removeItem(TOKEN_KEY);
}

export async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const t = loadAuth()?.token;
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

export const api = {
  register: (username, password) => request('/api/auth/register', { method: 'POST', body: { username, password }, auth: false }),
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password }, auth: false }),
  cards: () => request('/api/cards'),
  listRooms: () => request('/api/rooms', { auth: false }),
  createRoom: (payload) => request('/api/rooms', { method: 'POST', body: payload }),
  matches: () => request('/api/matches'),
};
