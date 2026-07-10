const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const roleTitle = role => ({ admin: 'Administrator', planner: 'Planner', manager: 'Manager', team_leader: 'Team Leader', coordinator: 'Coordinator', viewer: 'Viewer', employee: 'Employee' }[role] || role);
const requestTitle = type => ({ hours: 'Modificare ore', break: 'Modificare pauze', schedule: 'Modificare program', leave: 'Concediu', profile: 'Modificare profil' }[type] || type);
const statusBadge = status => `<span class="badge ${status === 'approved' || status === 'active' || status === 'published' ? 'green' : status === 'declined' || status === 'cancelled' ? 'red' : status === 'review' || status === 'draft' || status === 'invited' ? 'orange' : ''}">${esc(status)}</span>`;
const fmtDate = value => value ? new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium' }).format(new Date(`${value}T12:00:00`)) : '—';
const fmtDateTime = value => value ? new Intl.DateTimeFormat('nl-NL', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
const fmtTime = value => value ? new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date, days) => { const value = new Date(`${date}T12:00:00`); value.setDate(value.getDate() + days); return value.toISOString().slice(0, 10); };
const mondayOf = value => { const date = new Date(`${value}T12:00:00`); const day = date.getDay() || 7; date.setDate(date.getDate() - day + 1); return date.toISOString().slice(0, 10); };
const timeMinutes = value => { if (!/^\d{2}:\d{2}$/.test(value || '')) return null; const [h, m] = value.split(':').map(Number); return h * 60 + m; };
const minutesTime = value => { const n = ((Math.round(value) % 1440) + 1440) % 1440; return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; };
const shiftMinutes = (start, end) => { const a = timeMinutes(start), b = timeMinutes(end); if (a === null || b === null) return 0; return b > a ? b - a : b - a + 1440; };
const avatar = value => value || '/assets/default-avatar.svg';
const personHtml = employee => `<div class="person"><img src="${esc(avatar(employee?.photo_data))}" alt=""><div><strong>${esc(employee?.name || '—')}</strong><small>${esc(employee?.personnel_number || '')}</small></div></div>`;

const state = {
  csrf: '', profile: null, data: null, view: 'dashboard', week: mondayOf(today()),
  deferredInstall: null, inviteToken: null, modalSubmit: null,
};

function toast(message) {
  const element = $('#toast'); element.textContent = message; element.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 3200);
}

function authAlert(message, success = false) {
  const element = $('#authAlert'); element.textContent = message; element.className = `alert ${success ? 'success' : ''}`; element.classList.remove('hidden');
}
function clearAuthAlert() { $('#authAlert').classList.add('hidden'); }

async function api(path, { method = 'GET', body, csrf = method !== 'GET', raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf && state.csrf) headers['X-CSRF-Token'] = state.csrf;
  const response = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `HTTP ${response.status}`); error.status = response.status; throw error;
  }
  return result;
}

function permissions() {
  const role = state.profile?.role;
  return {
    admin: role === 'admin', employee: role === 'employee',
    editPlanning: ['admin', 'planner', 'manager', 'team_leader'].includes(role),
    review: ['admin', 'manager', 'team_leader'].includes(role),
    manageCars: ['admin', 'planner', 'manager', 'team_leader', 'coordinator'].includes(role),
  };
}

async function boot() {
  bindGlobal();
  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) { await showActivation(invite); return; }
  try {
    const session = await api('/api/auth/session', { csrf: false });
    state.csrf = session.csrf; state.profile = session.profile; await enterApp();
  } catch { $('#authScreen').classList.remove('hidden'); }
}

async function showActivation(token) {
  state.inviteToken = token;
  try {
    const info = await api(`/api/invites/${encodeURIComponent(token)}`, { csrf: false });
    $('#loginForm').classList.add('hidden'); $('#activationForm').classList.remove('hidden');
    $('#activationIdentity').innerHTML = `<img src="${esc(avatar(info.photo))}" alt=""><div><strong>${esc(info.name)}</strong><small>${esc(info.loginId)} · ${esc(roleTitle(info.role))}</small></div>`;
  } catch (error) { authAlert(error.message); }
}

async function enterApp() {
  $('#authScreen').classList.add('hidden'); $('#appShell').classList.remove('hidden');
  state.view = permissions().employee ? 'planning' : 'dashboard';
  updateIdentity(); applyNavigation(); await loadData(); render();
}

async function loadData() {
  const from = addDays(state.week, -42), to = addDays(state.week, 84);
  state.data = await api(`/api/bootstrap?from=${from}&to=${to}`, { csrf: false });
  state.profile = state.data.profile; updateIdentity();
}

function updateIdentity() {
  $('#topName').textContent = state.profile?.display_name || '—';
  $('#topRole').textContent = roleTitle(state.profile?.role);
  $('#topPhoto').src = avatar(state.profile?.photo_data);
  const agency = state.data?.agencies?.find(item => item.id === state.profile?.agency_id)?.name;
  const department = state.data?.departments?.find(item => item.id === state.profile?.department_id)?.name;
  $('#scopeContext').textContent = [agency, department].filter(Boolean).join(' · ') || 'Acces global';
}

function applyNavigation() {
  const p = permissions();
  $$('.nav-item').forEach(button => {
    const view = button.dataset.view;
    const allowed = ['dashboard', 'planning', 'cars', 'profile'].includes(view)
      || (view === 'clock' && p.employee)
      || (view === 'requests' && (p.employee || p.review))
      || (view === 'employees' && p.admin)
      || (view === 'users' && p.admin)
      || (view === 'admin' && p.admin);
    button.classList.toggle('hidden', !allowed);
  });
}

function setPage(title, subtitle, actions = '') {
  $('#pageContext').textContent = title;
  return `<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div><div class="page-actions">${actions}</div></div>`;
}

function render() {
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
  const renderers = { dashboard: renderDashboard, planning: renderPlanning, clock: renderClock, requests: renderRequests, employees: renderEmployees, cars: renderCars, users: renderUsers, admin: renderAdmin, profile: renderProfile };
  renderers[state.view]?.();
}

function employee(id) { return state.data.employees.find(item => item.id === id); }
function agency(id) { return state.data.agencies.find(item => item.id === id); }
function department(id) { return state.data.departments.find(item => item.id === id); }
function position(id) { return state.data.positions.find(item => item.id === id); }
function shift(id) { return state.data.shifts.find(item => item.id === id); }
function netHours(item) { return ((item.net_minutes ?? shiftMinutes(item.start_time, item.end_time)) / 60).toFixed(2); }
function totalBreak(item) { return item.break_total_minutes ?? (item.breaks || []).reduce((sum, b) => sum + Math.max(0, (timeMinutes(b.end) - timeMinutes(b.start) + 1440) % 1440), 0); }
