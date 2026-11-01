async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  });
  if (!res.ok) {
    // 登入過期 / 被撤銷：通知 App 登出（不在這裡 import store / router，避免循環依賴）
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('codd:unauthorized'));
    }
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

function partsList(parts) {
  return Array.isArray(parts) ? parts.join(',') : String(parts ?? '');
}

export const api = {
  // auth
  loginWithGoogle: (credential) => request('/auth/google', { method: 'POST', body: JSON.stringify({ credential }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),

  // skills
  listSkills: () => request('/skills'),
  getSkillSchema: () => request('/skills/_schema'),
  getSkill: (slug) => request(`/skills/${slug}`),
  saveSkill: (slug, body) => request(`/skills/${slug}`, { method: 'PUT', body: JSON.stringify(body) }),
  listSkillFiles: (slug) => request(`/skills/${slug}/files`),
  getSkillFile: (slug, path) => request(`/skills/${slug}/file?path=${encodeURIComponent(path)}`),

  // agents
  listAgents: () => request('/agents'),
  getAgentSchema: () => request('/agents/_schema'),
  getAgent: (slug) => request(`/agents/${slug}`),
  saveAgent: (slug, body) => request(`/agents/${slug}`, { method: 'PUT', body: JSON.stringify(body) }),

  // tasks
  listTasks: () => request('/tasks'),
  getTask: (slug) => request(`/tasks/${slug}`),
  saveTask: (slug, body) => request(`/tasks/${slug}`, { method: 'PUT', body: JSON.stringify(body) }),

  // memory
  listMemory: () => request('/memory'),
  getMemory: (date) => request(`/memory/${date}`),

  // status
  getStatus: () => request('/status'),

  // launch profiles（UI 上叫 Projects；profile 物件多一個 color 欄位）
  listProfiles: () => request('/launch-profiles'),
  getProfile: (id) => request(`/launch-profiles/${id}`),
  createProfile: (data) => request('/launch-profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateProfile: (id, data) => request(`/launch-profiles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProfile: (id) => request(`/launch-profiles/${id}`, { method: 'DELETE' }),

  // terminal sessions
  listSessions: () => request('/terminal/sessions'),
  getSession: (id) => request(`/terminal/sessions/${id}`),
  getSessionLog: (id, tail = 200) => request(`/terminal/sessions/${id}/log?tail=${tail}`),
  spawnSession: (profile_id, size) => request('/terminal/sessions', {
    method: 'POST',
    body: JSON.stringify({ profile_id, ...(size ? { cols: size.cols, rows: size.rows } : {}) }),
  }),
  resizeSession: (id, { cols, rows, client_id }) => request(`/terminal/sessions/${id}/resize`, {
    method: 'POST',
    body: JSON.stringify({ cols, rows, client_id }),
  }),
  reorderSessions: (ids) => request('/terminal/sessions/order', { method: 'PUT', body: JSON.stringify({ ids }) }),
  killSession: (id) => request(`/terminal/sessions/${id}/kill`, { method: 'POST' }),
  removeSession: (id) => request(`/terminal/sessions/${id}`, { method: 'DELETE' }),
  restartSession: (id) => request(`/terminal/sessions/${id}/restart`, { method: 'POST' }),
  openSessionDesktop: (id) => request(`/terminal/sessions/${id}/open-desktop`, { method: 'POST' }),
  sendSessionInput: (id, base64) => request(`/terminal/sessions/${id}/input`, {
    method: 'POST',
    body: JSON.stringify({ data: base64 }),
  }),
  // 標記色：color = palette key（見 colors.js）或 null（清除）
  setSessionColor: (id, color) => request(`/terminal/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ color }),
  }),

  // system / device status（含 statusline 回報的目前帳號用量；沒有 cswap 時的退路）
  getSystem: () => request('/system'),

  // 帳號與用量：Claude（cswap）與 Codex（codex app-server + 本機帳號庫）
  getClaudeAccounts: ({ refresh = false } = {}) => request(`/accounts/claude${refresh ? '?refresh=1' : ''}`),
  switchClaudeAccount: (number) => request('/accounts/claude/switch', {
    method: 'POST',
    body: JSON.stringify({ number }),
  }),
  getCodexAccounts: ({ refresh = false } = {}) => request(`/accounts/codex${refresh ? '?refresh=1' : ''}`),
  saveCodexAccount: (label) => request('/accounts/codex/save-current', {
    method: 'POST',
    body: JSON.stringify({ label: label ?? null }),
  }),
  switchCodexAccount: (id) => request('/accounts/codex/switch', {
    method: 'POST',
    body: JSON.stringify({ id }),
  }),
  renameCodexAccount: (id, label) => request(`/accounts/codex/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ label }),
  }),
  removeCodexAccount: (id) => request(`/accounts/codex/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // setup / onboarding（user-level ~/.claude/settings.json hooks + statusLine）
  getSetup: () => request('/setup'),
  planSetup: (parts) => request(`/setup/plan?parts=${encodeURIComponent(partsList(parts))}`),
  applySetup: (parts) => request('/setup/apply', { method: 'POST', body: JSON.stringify({ parts }) }),
  uninstallSetup: (parts) => request('/setup/uninstall', { method: 'POST', body: JSON.stringify({ parts }) }),

  // identity
  listIdentity: () => request('/identity'),
  getIdentity: (name) => request(`/identity/${encodeURIComponent(name)}`),
  saveIdentity: (name, body) => request(`/identity/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(body) }),

  // kanban
  listColumns: () => request('/kanban/columns'),
  listCards: () => request('/kanban/cards'),
  createCard: (data) => request('/kanban/cards', { method: 'POST', body: JSON.stringify(data) }),
  updateCard: (id, data) => request(`/kanban/cards/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteCard: (id) => request(`/kanban/cards/${id}`, { method: 'DELETE' }),
};
