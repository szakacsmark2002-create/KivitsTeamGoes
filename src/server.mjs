import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { config } from './config.mjs';
import { db, row, rows, run, id, nowIso, transaction, audit, userPublic, parseJson, createBackup, listBackups } from './db.mjs';
import {
  randomToken, sha256, passwordRecord, verifyPassword, validPassword,
  parseCookies, sessionCookie, clearSessionCookie, securityHeaders, readJson, cleanText, isImageData,
} from './security.mjs';
import {
  validRole, validateBreaks, defaultBreaks, shiftDurationMinutes, plannedInterval,
  canViewEmployee, canManageEmployee, canReviewEmployee, canManageCars,
} from './domain.mjs';

const routes = [];
const loginRate = new Map();
const baseHeaders = securityHeaders({ production: config.production });
const SESSION_SECONDS = config.sessionHours * 3600;

function route(method, pattern, handler) {
  const keys = [];
  const source = pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => { keys.push(key); return '([^/]+)'; });
  routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function requestOrigin(req) {
  if (config.appOrigin) return config.appOrigin.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || (config.cookieSecure ? 'https' : 'http')).split(',')[0];
  return `${proto}://${req.headers.host}`;
}

function writeJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...baseHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function errorResponse(res, error) {
  const status = Number(error.status || 500);
  if (status >= 500) console.error(error);
  writeJson(res, status, { error: status >= 500 ? 'Eroare internă a serverului.' : error.message });
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function bool(value) { return value ? 1 : 0; }
function dateOnly(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null; }
function timeOnly(value) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')) ? String(value) : null; }
function photo(value) { if (!isImageData(value)) fail('Fotografia este invalidă sau prea mare.'); return value || null; }
function listValue(value) {
  if (Array.isArray(value)) return value.map(item => cleanText(item, 100)).filter(Boolean).slice(0, 100);
  return String(value || '').split(/[,\n]/).map(item => cleanText(item, 100)).filter(Boolean).slice(0, 100);
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie || '').kivits_session;
  if (!token) return null;
  const tokenHash = sha256(token);
  const session = row(`SELECT s.*, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`, tokenHash);
  if (!session) return null;
  if (!session.active || Date.parse(session.expires_at) <= Date.now()) {
    run('DELETE FROM sessions WHERE token_hash=?', tokenHash);
    return null;
  }
  run('UPDATE sessions SET last_seen_at=? WHERE token_hash=?', nowIso(), tokenHash);
  return { tokenHash, session, user: userPublic(session) };
}

function requireAuth(req) {
  const context = getSession(req);
  if (!context) fail('Autentificare necesară.', 401);
  return context;
}

function requireCsrf(req, context) {
  const csrf = String(req.headers['x-csrf-token'] || '');
  if (!csrf || sha256(csrf) !== context.session.csrf_hash) fail('Token CSRF invalid. Reîncarcă aplicația.', 403);
}

function requireAdmin(context) {
  if (context.user.role !== 'admin') fail('Acces disponibil numai Administratorului.', 403);
}

function createSession(req, userId) {
  const token = randomToken();
  const csrf = randomToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  run(`INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at,created_at,last_seen_at,ip,user_agent) VALUES(?,?,?,?,?,?,?,?)`,
    sha256(token), userId, sha256(csrf), expiresAt, createdAt, createdAt, clientIp(req), cleanText(req.headers['user-agent'], 500));
  return { token, csrf, expiresAt };
}

function rotateCsrf(context) {
  const csrf = randomToken();
  run('UPDATE sessions SET csrf_hash=?,last_seen_at=? WHERE token_hash=?', sha256(csrf), nowIso(), context.tokenHash);
  return csrf;
}

function visibleEmployees(user) {
  return rows('SELECT * FROM employees WHERE active=1 ORDER BY name COLLATE NOCASE').filter(employee => canViewEmployee(user, employee));
}

function employeeOrFail(employeeId) {
  const employee = row('SELECT * FROM employees WHERE id=?', employeeId);
  if (!employee) fail('Angajatul nu există.', 404);
  return employee;
}

function shiftOrFail(shiftId) {
  const shift = row('SELECT * FROM shifts WHERE id=?', shiftId);
  if (!shift) fail('Tura nu există.', 404);
  return shift;
}

function shiftBreaks(shiftId) {
  return rows('SELECT id,label,start_time AS start,end_time AS end,paid,sort_order FROM shift_breaks WHERE shift_id=? ORDER BY sort_order,start_time', shiftId)
    .map(item => ({ ...item, paid: Boolean(item.paid) }));
}

function shiftWithBreaks(shift) {
  const breaks = shiftBreaks(shift.id);
  const check = validateBreaks(shift.start_time, shift.end_time, breaks);
  return {
    ...shift,
    breaks,
    break_total_minutes: check.valid ? check.totalMinutes : 0,
    unpaid_break_minutes: check.valid ? check.unpaidMinutes : 0,
    paid_break_minutes: check.valid ? check.paidMinutes : 0,
    net_minutes: check.valid ? check.netMinutes : shiftDurationMinutes(shift.start_time, shift.end_time),
  };
}

function normalizeBreakInput(start, end, input, autoBreak = false) {
  let breaks = Array.isArray(input) ? input.map((item, index) => ({
    id: cleanText(item.id, 80) || null,
    label: cleanText(item.label || `Pauza ${index + 1}`, 80),
    start: timeOnly(item.start),
    end: timeOnly(item.end),
    paid: Boolean(item.paid),
  })) : [];
  if (!breaks.length && autoBreak) breaks = defaultBreaks(start, end);
  const check = validateBreaks(start, end, breaks);
  if (!check.valid) fail(check.message);
  return check.breaks;
}

function saveShiftBreaks(shiftId, breaks) {
  run('DELETE FROM shift_breaks WHERE shift_id=?', shiftId);
  const statement = db.prepare('INSERT INTO shift_breaks(id,shift_id,label,start_time,end_time,paid,sort_order) VALUES(?,?,?,?,?,?,?)');
  breaks.forEach((item, index) => statement.run(id(), shiftId, item.label, item.start, item.end, bool(item.paid), index));
}

function requestWithBreaks(request) {
  return { ...request, requested_breaks: parseJson(request.requested_breaks_json, []) };
}

function validateRequestBreaks(start, end, breaks) {
  if (!breaks?.length) return [];
  if (!start || !end) fail('Orele propuse sunt necesare pentru validarea pauzelor.');
  return normalizeBreakInput(start, end, breaks, false).map(item => ({ label: item.label, start: item.start, end: item.end, paid: item.paid }));
}

function applyApprovedRequest(request) {
  if (!request.shift_id) return;
  const shift = shiftOrFail(request.shift_id);
  const start = request.requested_start || shift.start_time;
  const end = request.requested_end || shift.end_time;
  const requestedBreaks = parseJson(request.requested_breaks_json, []);
  const breaks = requestedBreaks.length ? normalizeBreakInput(start, end, requestedBreaks, false) : shiftBreaks(shift.id);
  run(`UPDATE shifts SET date=?,start_time=?,end_time=?,updated_at=? WHERE id=?`, request.requested_date || shift.date, start, end, nowIso(), shift.id);
  if (requestedBreaks.length) saveShiftBreaks(shift.id, breaks);
}

function profileFromEmployee(employee, base = {}) {
  return {
    display_name: employee.name,
    card_id: employee.card_id,
    email: employee.email,
    phone: employee.phone,
    address: employee.address,
    birth_date: employee.birth_date,
    emergency_name: employee.emergency_name,
    emergency_phone: employee.emergency_phone,
    photo_data: employee.photo_data,
    agency_id: employee.agency_id,
    department_id: employee.department_id,
    ...base,
  };
}

function buildBootstrap(user, from, to) {
  const employees = visibleEmployees(user);
  const employeeIds = new Set(employees.map(item => item.id));
  const allShifts = rows('SELECT * FROM shifts WHERE date BETWEEN ? AND ? ORDER BY date,start_time', from, to)
    .filter(item => employeeIds.has(item.employee_id)).map(shiftWithBreaks);
  const requests = rows('SELECT * FROM change_requests ORDER BY created_at DESC LIMIT 1000')
    .filter(item => employeeIds.has(item.employee_id)).map(requestWithBreaks);
  const attendance = rows('SELECT * FROM attendance ORDER BY clock_in_actual DESC LIMIT 1000')
    .filter(item => employeeIds.has(item.employee_id));
  const trips = rows('SELECT * FROM car_trips WHERE date BETWEEN ? AND ? ORDER BY date,departure_time', from, to)
    .filter(trip => employeeIds.has(trip.driver_employee_id) || rows('SELECT employee_id FROM car_trip_passengers WHERE trip_id=?', trip.id).some(p => employeeIds.has(p.employee_id)))
    .map(trip => ({ ...trip, passenger_ids: rows('SELECT employee_id FROM car_trip_passengers WHERE trip_id=?', trip.id).map(item => item.employee_id) }));
  return {
    profile: userPublic(user),
    serverTime: nowIso(),
    timezone: config.timezone,
    agencies: rows('SELECT * FROM agencies ORDER BY name'),
    departments: rows('SELECT * FROM departments ORDER BY name'),
    positions: rows('SELECT * FROM positions ORDER BY name'),
    employees,
    shifts: allShifts,
    requests,
    attendance,
    vehicles: rows('SELECT * FROM vehicles WHERE active=1 ORDER BY name'),
    carTrips: trips,
    users: user.role === 'admin' ? rows('SELECT * FROM users ORDER BY display_name').map(userPublic) : [],
    audit: user.role === 'admin' ? rows('SELECT a.*,u.display_name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 300') : [],
    backups: user.role === 'admin' ? listBackups() : [],
  };
}

function integrityReport() {
  const orphanShifts = row('SELECT COUNT(*) AS count FROM shifts s LEFT JOIN employees e ON e.id=s.employee_id WHERE e.id IS NULL').count;
  const invalidBreaks = rows('SELECT * FROM shifts').filter(shift => !validateBreaks(shift.start_time, shift.end_time, shiftBreaks(shift.id)).valid).length;
  const locked = row(`SELECT COUNT(*) AS count FROM users WHERE locked_until IS NOT NULL AND locked_until>?`, nowIso()).count;
  const draft = row(`SELECT COUNT(*) AS count FROM shifts WHERE status='draft'`).count;
  const reviews = row(`SELECT COUNT(*) AS count FROM change_requests WHERE status='review'`).count;
  const inactive = row(`SELECT COUNT(*) AS count FROM users WHERE active=0`).count;
  return { orphanShifts, invalidBreaks, lockedAccounts: locked, draftShifts: draft, openRequests: reviews, inactiveAccounts: inactive };
}

function loginRateKey(req, loginId) { return `${clientIp(req)}|${String(loginId).toLowerCase()}`; }
function rateAllowed(key) {
  const now = Date.now();
  const item = loginRate.get(key) || { count: 0, reset: now + 15 * 60_000 };
  if (now > item.reset) { item.count = 0; item.reset = now + 15 * 60_000; }
  item.count += 1; loginRate.set(key, item);
  return item.count <= 20;
}
function clearRate(key) { loginRate.delete(key); }

route('GET', '/api/health', async (_req, res) => {
  writeJson(res, 200, { status: 'ok', version: '2.0.0', database: 'sqlite', time: nowIso() });
});

route('POST', '/api/auth/login', async (req, res) => {
  const body = await readJson(req, config.maxJsonBytes);
  const loginId = cleanText(body.loginId, 64);
  const key = loginRateKey(req, loginId);
  if (!rateAllowed(key)) fail('Prea multe încercări. Încearcă mai târziu.', 429);
  const user = row('SELECT * FROM users WHERE login_id=? COLLATE NOCASE', loginId);
  const invalid = () => fail('ID sau parolă incorectă.', 401);
  if (!user || !user.active || !user.password_hash) invalid();
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) fail('Cont temporar blocat. Contactează Administratorul.', 423);
  if (!verifyPassword(String(body.password || ''), user.password_salt, user.password_hash)) {
    const attempts = Number(user.failed_attempts || 0) + 1;
    const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    run('UPDATE users SET failed_attempts=?,locked_until=?,updated_at=? WHERE id=?', attempts, lockedUntil, nowIso(), user.id);
    audit(user.id, 'auth.login.failed', 'user', user.id, { attempts }, clientIp(req));
    invalid();
  }
  clearRate(key);
  run('UPDATE users SET failed_attempts=0,locked_until=NULL,last_login_at=?,updated_at=? WHERE id=?', nowIso(), nowIso(), user.id);
  const session = createSession(req, user.id);
  audit(user.id, 'auth.login.succeeded', 'user', user.id, {}, clientIp(req));
  writeJson(res, 200, { profile: userPublic({ ...user, last_login_at: nowIso() }), csrf: session.csrf, expiresAt: session.expiresAt }, {
    'Set-Cookie': sessionCookie(session.token, { secure: config.cookieSecure, maxAge: SESSION_SECONDS }),
  });
});

route('GET', '/api/auth/session', async (req, res) => {
  const context = requireAuth(req);
  writeJson(res, 200, { profile: context.user, csrf: rotateCsrf(context), expiresAt: context.session.expires_at });
});

route('POST', '/api/auth/logout', async (req, res) => {
  const context = getSession(req);
  if (context) {
    requireCsrf(req, context);
    run('DELETE FROM sessions WHERE token_hash=?', context.tokenHash);
    audit(context.user.id, 'auth.logout', 'user', context.user.id, {}, clientIp(req));
  }
  writeJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie({ secure: config.cookieSecure }) });
});

route('GET', '/api/invites/:token', async (_req, res, params) => {
  const invitation = row(`SELECT i.*,u.login_id,u.display_name,u.role,u.photo_data FROM invitations i JOIN users u ON u.id=i.user_id WHERE i.token_hash=?`, sha256(params.token));
  if (!invitation || invitation.used_at || Date.parse(invitation.expires_at) <= Date.now()) fail('Invitația este invalidă sau a expirat.', 404);
  writeJson(res, 200, { loginId: invitation.login_id, name: invitation.display_name, role: invitation.role, photo: invitation.photo_data, expiresAt: invitation.expires_at });
});

route('POST', '/api/invites/:token/activate', async (req, res, params) => {
  const body = await readJson(req, config.maxJsonBytes);
  if (!validPassword(body.password)) fail('Parola trebuie să aibă minimum 8 caractere, literă mare, literă mică și cifră.');
  const tokenHash = sha256(params.token);
  const invitation = row('SELECT * FROM invitations WHERE token_hash=?', tokenHash);
  if (!invitation || invitation.used_at || Date.parse(invitation.expires_at) <= Date.now()) fail('Invitația este invalidă sau a expirat.', 404);
  const password = passwordRecord(body.password);
  transaction(() => {
    run('UPDATE users SET password_hash=?,password_salt=?,active=1,must_change_password=0,updated_at=? WHERE id=?', password.hash, password.salt, nowIso(), invitation.user_id);
    run('UPDATE invitations SET used_at=? WHERE id=?', nowIso(), invitation.id);
    audit(invitation.user_id, 'invitation.activated', 'user', invitation.user_id, {}, clientIp(req));
  });
  const user = row('SELECT login_id FROM users WHERE id=?', invitation.user_id);
  writeJson(res, 200, { ok: true, loginId: user.login_id });
});

route('GET', '/api/bootstrap', async (req, res) => {
  const context = requireAuth(req);
  const url = new URL(req.url, 'http://localhost');
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 35 * 86400000).toISOString().slice(0, 10);
  const defaultTo = new Date(today.getTime() + 70 * 86400000).toISOString().slice(0, 10);
  const from = dateOnly(url.searchParams.get('from')) || defaultFrom;
  const to = dateOnly(url.searchParams.get('to')) || defaultTo;
  writeJson(res, 200, { ...buildBootstrap(context.user, from, to), integrity: context.user.role === 'admin' ? integrityReport() : null });
});

route('PUT', '/api/profile', async (req, res) => {
  const context = requireAuth(req); requireCsrf(req, context);
  const body = await readJson(req, config.maxJsonBytes);
  const loginId = cleanText(body.loginId ?? context.user.login_id, 64);
  if (!/^[A-Za-z0-9._-]{4,32}$/.test(loginId)) fail('ID de conectare invalid.');
  const duplicateLogin = row('SELECT id FROM users WHERE login_id=? COLLATE NOCASE AND id<>?', loginId, context.user.id);
  if (duplicateLogin) fail('ID-ul de conectare este deja folosit.');
  const cardId = cleanText(body.cardId ?? context.user.card_id, 64);
  if (!cardId) fail('Card ID este obligatoriu.');
  const duplicateCard = row('SELECT id FROM users WHERE card_id=? COLLATE NOCASE AND id<>?', cardId, context.user.id);
  if (duplicateCard) fail('Card ID este deja folosit.');
  if (body.newPassword) {
    if (!verifyPassword(String(body.currentPassword || ''), context.session.password_salt, context.session.password_hash)) fail('Parola actuală este incorectă.', 403);
    if (!validPassword(body.newPassword)) fail('Parola nouă nu respectă cerințele.');
  }
  const values = {
    loginId,
    displayName: cleanText(body.displayName ?? context.user.display_name, 120),
    cardId,
    email: cleanText(body.email, 200), phone: cleanText(body.phone, 80), address: cleanText(body.address, 500),
    birthDate: dateOnly(body.birthDate), emergencyName: cleanText(body.emergencyName, 120), emergencyPhone: cleanText(body.emergencyPhone, 80),
    language: ['ro', 'nl', 'en'].includes(body.language) ? body.language : 'ro', notifications: bool(body.notifications),
    personalNote: cleanText(body.personalNote, 2000), photoData: photo(body.photoData),
  };
  transaction(() => {
    run(`UPDATE users SET login_id=?,display_name=?,card_id=?,email=?,phone=?,address=?,birth_date=?,emergency_name=?,emergency_phone=?,language=?,notifications=?,personal_note=?,photo_data=?,must_change_password=?,updated_at=? WHERE id=?`,
      values.loginId, values.displayName, values.cardId, values.email, values.phone, values.address, values.birthDate, values.emergencyName, values.emergencyPhone,
      values.language, values.notifications, values.personalNote, values.photoData, body.newPassword ? 0 : context.user.must_change_password, nowIso(), context.user.id);
    if (body.newPassword) {
      const password = passwordRecord(body.newPassword);
      run('UPDATE users SET password_hash=?,password_salt=? WHERE id=?', password.hash, password.salt, context.user.id);
    }
    if (context.user.employee_id) {
      run(`UPDATE employees SET name=?,card_id=?,email=?,phone=?,address=?,birth_date=?,emergency_name=?,emergency_phone=?,photo_data=?,preferred_language=?,updated_at=? WHERE id=?`,
        values.displayName, values.cardId, values.email, values.phone, values.address, values.birthDate, values.emergencyName, values.emergencyPhone, values.photoData, values.language, nowIso(), context.user.employee_id);
    }
    audit(context.user.id, 'profile.updated', 'user', context.user.id, { fields: Object.keys(body).filter(key => !key.toLowerCase().includes('password')) }, clientIp(req));
  });
  writeJson(res, 200, { profile: userPublic(row('SELECT * FROM users WHERE id=?', context.user.id)) });
});

route('POST', '/api/employees', async (req, res) => {
  const context = requireAuth(req); requireCsrf(req, context); requireAdmin(context);
  const body = await readJson(req, config.maxJsonBytes);
  const employeeId = id();
  const createdAt = nowIso();
  const name = cleanText(body.name, 120), personnel = cleanText(body.personnelNumber, 80), cardId = cleanText(body.cardId, 80);
  if (!name || !personnel || !cardId) fail('Numele, numărul personal și Card ID sunt obligatorii.');
  if (!row('SELECT id FROM agencies WHERE id=?', body.agencyId) || !row('SELECT id FROM departments WHERE id=?', body.departmentId) || !row('SELECT id FROM positions WHERE id=?', body.positionId)) fail('Structura organizațională este invalidă.');
  run(`INSERT INTO employees(id,name,personnel_number,card_id,email,phone,address,birth_date,emergency_name,emergency_phone,agency_id,department_id,position_id,photo_data,contract_type,start_date,weekly_hours,certifications_json,skills_json,preferred_language,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, employeeId, name, personnel, cardId, cleanText(body.email,200), cleanText(body.phone,80), cleanText(body.address,500), dateOnly(body.birthDate), cleanText(body.emergencyName,120), cleanText(body.emergencyPhone,80), body.agencyId, body.departmentId, body.positionId, photo(body.photoData), cleanText(body.contractType,100), dateOnly(body.startDate), Number(body.weeklyHours||40), JSON.stringify(listValue(body.certifications)), JSON.stringify(listValue(body.skills)), ['ro','nl','en'].includes(body.preferredLanguage)?body.preferredLanguage:'nl', 1, createdAt, createdAt);
  audit(context.user.id, 'employee.created', 'employee', employeeId, { name }, clientIp(req));
  writeJson(res, 201, { id: employeeId });
});

route('PUT', '/api/employees/:id', async (req, res, params) => {
  const context = requireAuth(req); requireCsrf(req, context); requireAdmin(context);
  employeeOrFail(params.id);
  const body = await readJson(req, config.maxJsonBytes);
  const name = cleanText(body.name,120), personnel=cleanText(body.personnelNumber,80), cardId=cleanText(body.cardId,80);
  if(!name||!personnel||!cardId) fail('Numele, numărul personal și Card ID sunt obligatorii.');
  transaction(()=>{
    run(`UPDATE employees SET name=?,personnel_number=?,card_id=?,email=?,phone=?,address=?,birth_date=?,emergency_name=?,emergency_phone=?,agency_id=?,department_id=?,position_id=?,photo_data=?,contract_type=?,start_date=?,weekly_hours=?,certifications_json=?,skills_json=?,preferred_language=?,active=?,updated_at=? WHERE id=?`,
      name,personnel,cardId,cleanText(body.email,200),cleanText(body.phone,80),cleanText(body.address,500),dateOnly(body.birthDate),cleanText(body.emergencyName,120),cleanText(body.emergencyPhone,80),body.agencyId,body.departmentId,body.positionId,photo(body.photoData),cleanText(body.contractType,100),dateOnly(body.startDate),Number(body.weeklyHours||40),JSON.stringify(listValue(body.certifications)),JSON.stringify(listValue(body.skills)),['ro','nl','en'].includes(body.preferredLanguage)?body.preferredLanguage:'nl',bool(body.active),nowIso(),params.id);
    const linked=row('SELECT id FROM users WHERE employee_id=?',params.id);
    if(linked) run(`UPDATE users SET display_name=?,card_id=?,email=?,phone=?,address=?,birth_date=?,emergency_name=?,emergency_phone=?,agency_id=?,department_id=?,photo_data=?,updated_at=? WHERE id=?`,name,cardId,cleanText(body.email,200),cleanText(body.phone,80),cleanText(body.address,500),dateOnly(body.birthDate),cleanText(body.emergencyName,120),cleanText(body.emergencyPhone,80),body.agencyId,body.departmentId,photo(body.photoData),nowIso(),linked.id);
    audit(context.user.id,'employee.updated','employee',params.id,{name},clientIp(req));
  });
  writeJson(res,200,{ok:true});
});

route('POST','/api/planning/copy-week',async(req,res)=>{
  const context=requireAuth(req);requireCsrf(req,context);if(!['admin','planner','manager','team_leader'].includes(context.user.role)) fail('Nu ai dreptul să copiezi planningul.',403);
  const body=await readJson(req,config.maxJsonBytes);const source=dateOnly(body.sourceMonday),target=dateOnly(body.targetMonday);if(!source||!target) fail('Săptămânile sunt invalide.');
  const sourceEnd=new Date(`${source}T12:00:00`);sourceEnd.setDate(sourceEnd.getDate()+6);const sourceEndDate=sourceEnd.toISOString().slice(0,10);const delta=(new Date(`${target}T12:00:00`)-new Date(`${source}T12:00:00`))/86400000;let affected=0;
  const sourceShifts=rows('SELECT * FROM shifts WHERE date BETWEEN ? AND ? AND status<>\'cancelled\' ORDER BY date,start_time',source,sourceEndDate);
  transaction(()=>{for(const original of sourceShifts){const employee=employeeOrFail(original.employee_id);if(!canManageEmployee(context.user,employee))continue;const targetDate=new Date(`${original.date}T12:00:00`);targetDate.setDate(targetDate.getDate()+delta);const dateValue=targetDate.toISOString().slice(0,10);if(row('SELECT id FROM shifts WHERE employee_id=? AND date=? AND start_time=?',original.employee_id,dateValue,original.start_time))continue;const newId=id(),now=nowIso();run(`INSERT INTO shifts(id,employee_id,date,start_time,end_time,status,note,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,newId,original.employee_id,dateValue,original.start_time,original.end_time,'draft',original.note,context.user.id,now,now);saveShiftBreaks(newId,shiftBreaks(original.id));affected++}audit(context.user.id,'planning.week.copied','planning',null,{source,target,affected},clientIp(req));});
  writeJson(res,200,{ok:true,affected});
});

route('POST','/api/planning/publish-week',async(req,res)=>{
  const context=requireAuth(req);requireCsrf(req,context);if(!['admin','planner','manager','team_leader'].includes(context.user.role)) fail('Nu ai dreptul să publici planningul.',403);const body=await readJson(req,config.maxJsonBytes);const monday=dateOnly(body.monday);if(!monday)fail('Săptămână invalidă.');const endDate=new Date(`${monday}T12:00:00`);endDate.setDate(endDate.getDate()+6);const end=endDate.toISOString().slice(0,10);let affected=0;
  transaction(()=>{for(const shift of rows(`SELECT * FROM shifts WHERE date BETWEEN ? AND ? AND status='draft'`,monday,end)){const employee=employeeOrFail(shift.employee_id);if(!canManageEmployee(context.user,employee))continue;run(`UPDATE shifts SET status='published',updated_at=? WHERE id=?`,nowIso(),shift.id);affected++}audit(context.user.id,'planning.week.published','planning',null,{monday,affected},clientIp(req));});writeJson(res,200,{ok:true,affected});
});

route('POST', '/api/shifts', async (req, res) => {
  const context=requireAuth(req);requireCsrf(req,context);
  const body=await readJson(req,config.maxJsonBytes);const employee=employeeOrFail(body.employeeId);
  if(!canManageEmployee(context.user,employee)) fail('Nu ai dreptul să planifici acest angajat.',403);
  const date=dateOnly(body.date),start=timeOnly(body.start),end=timeOnly(body.end);if(!date||!start||!end||!shiftDurationMinutes(start,end)) fail('Data sau orele turei sunt invalide.');
  const breaks=normalizeBreakInput(start,end,body.breaks,body.autoBreak!==false);const shiftId=id();const now=nowIso();
  transaction(()=>{run(`INSERT INTO shifts(id,employee_id,date,start_time,end_time,status,note,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,shiftId,employee.id,date,start,end,['draft','published','cancelled'].includes(body.status)?body.status:'published',cleanText(body.note,1000),context.user.id,now,now);saveShiftBreaks(shiftId,breaks);audit(context.user.id,'shift.created','shift',shiftId,{employeeId:employee.id,date},clientIp(req));});
  writeJson(res,201,{id:shiftId});
});

route('PUT', '/api/shifts/:id', async (req,res,params)=>{
  const context=requireAuth(req);requireCsrf(req,context);const existing=shiftOrFail(params.id);const employee=employeeOrFail(existing.employee_id);
  if(!canManageEmployee(context.user,employee)) fail('Nu ai dreptul să modifici această tură.',403);
  const body=await readJson(req,config.maxJsonBytes);const date=dateOnly(body.date),start=timeOnly(body.start),end=timeOnly(body.end);if(!date||!start||!end||!shiftDurationMinutes(start,end)) fail('Data sau orele turei sunt invalide.');
  const breaks=normalizeBreakInput(start,end,body.breaks,false);
  transaction(()=>{run(`UPDATE shifts SET date=?,start_time=?,end_time=?,status=?,note=?,updated_at=? WHERE id=?`,date,start,end,['draft','published','cancelled'].includes(body.status)?body.status:'published',cleanText(body.note,1000),nowIso(),existing.id);saveShiftBreaks(existing.id,breaks);audit(context.user.id,'shift.updated','shift',existing.id,{date},clientIp(req));});
  writeJson(res,200,{ok:true});
});

route('DELETE','/api/shifts/:id',async(req,res,params)=>{
  const context=requireAuth(req);requireCsrf(req,context);const shift=shiftOrFail(params.id);const employee=employeeOrFail(shift.employee_id);if(!canManageEmployee(context.user,employee)) fail('Nu ai dreptul să ștergi această tură.',403);
  run('DELETE FROM shifts WHERE id=?',shift.id);audit(context.user.id,'shift.deleted','shift',shift.id,{},clientIp(req));writeJson(res,200,{ok:true});
});

route('POST','/api/clock/in',async(req,res)=>{
  const context=requireAuth(req);requireCsrf(req,context);if(context.user.role!=='employee'||!context.user.employee_id) fail('Clock-in este disponibil conturilor Employee.',403);
  if(row('SELECT id FROM attendance WHERE employee_id=? AND clock_out_actual IS NULL ORDER BY clock_in_actual DESC LIMIT 1',context.user.employee_id)) fail('Există deja un clock-in deschis.');
  const now=new Date();const today=now.toISOString().slice(0,10);const candidates=rows(`SELECT * FROM shifts WHERE employee_id=? AND date BETWEEN ? AND ? AND status<>'cancelled'`,context.user.employee_id,new Date(now.getTime()-86400000).toISOString().slice(0,10),new Date(now.getTime()+86400000).toISOString().slice(0,10));
  let selected=null,distance=Infinity;for(const shift of candidates){const interval=plannedInterval(shift);if(!interval.start)continue;const current=Math.abs(interval.start-now);if(current<distance){distance=current;selected=shift}}
  const interval=selected?plannedInterval(selected):null;const calculated=interval?.start&&now<interval.start?interval.start:now;const attendanceId=id();
  run(`INSERT INTO attendance(id,employee_id,shift_id,clock_in_actual,clock_in_calculated,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)`,attendanceId,context.user.employee_id,selected?.id||null,now.toISOString(),calculated.toISOString(),'self clock-in',context.user.id,nowIso());audit(context.user.id,'attendance.clock_in','attendance',attendanceId,{shiftId:selected?.id||null},clientIp(req));writeJson(res,201,{id:attendanceId,actual:now.toISOString(),calculated:calculated.toISOString()});
});

route('POST','/api/clock/out',async(req,res)=>{
  const context=requireAuth(req);requireCsrf(req,context);if(context.user.role!=='employee'||!context.user.employee_id) fail('Clock-out este disponibil conturilor Employee.',403);
  const open=row('SELECT * FROM attendance WHERE employee_id=? AND clock_out_actual IS NULL ORDER BY clock_in_actual DESC LIMIT 1',context.user.employee_id);if(!open) fail('Nu există un clock-in deschis.');
  const now=nowIso();run('UPDATE attendance SET clock_out_actual=?,clock_out_calculated=? WHERE id=?',now,now,open.id);audit(context.user.id,'attendance.clock_out','attendance',open.id,{},clientIp(req));writeJson(res,200,{ok:true,actual:now});
});

route('POST','/api/attendance/manual',async(req,res)=>{
  const context=requireAuth(req);requireCsrf(req,context);requireAdmin(context);const body=await readJson(req,config.maxJsonBytes);const employee=employeeOrFail(body.employeeId);const inActual=new Date(body.clockInActual),outActual=body.clockOutActual?new Date(body.clockOutActual):null;if(Number.isNaN(inActual.getTime())||(outActual&&Number.isNaN(outActual.getTime()))) fail('Ore de pontaj invalide.');
  const attendanceId=id();run(`INSERT INTO attendance(id,employee_id,shift_id,clock_in_actual,clock_in_calculated,clock_out_actual,clock_out_calculated,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,attendanceId,employee.id,body.shiftId||null,inActual.toISOString(),new Date(body.clockInCalculated||inActual).toISOString(),outActual?.toISOString()||null,outActual?new Date(body.clockOutCalculated||outActual).toISOString():null,cleanText(body.note,1000),context.user.id,nowIso());audit(context.user.id,'attendance.manual.created','attendance',attendanceId,{employeeId:employee.id},clientIp(req));writeJson(res,201,{id:attendanceId});
});

route('POST','/api/requests',async(req,res)=>{
  const context=requireAuth(req);requireCsrf(req,context);if(context.user.role!=='employee'||!context.user.employee_id) fail('Cererea poate fi trimisă numai de Employee.',403);const body=await readJson(req,config.maxJsonBytes);const type=body.type;if(!['hours','break','schedule','leave','profile'].includes(type)) fail('Tipul cererii este invalid.');
  let shift=null;if(type!=='leave'&&type!=='profile'){shift=shiftOrFail(body.shiftId);if(shift.employee_id!==context.user.employee_id) fail('Tura selectată nu îți aparține.',403);const interval=plannedInterval(shift);const clockedOut=row('SELECT id FROM attendance WHERE employee_id=? AND shift_id=? AND clock_out_actual IS NOT NULL LIMIT 1',context.user.employee_id,shift.id);if(interval.end>Date.now()&&!clockedOut) fail('Request review este disponibil după finalul turei sau după clock-out.');}
  const requestedStart=timeOnly(body.requestedStart),requestedEnd=timeOnly(body.requestedEnd);const requestedBreaks=validateRequestBreaks(requestedStart||shift?.start_time,requestedEnd||shift?.end_time,body.breaks||[]);const requestId=id(),now=nowIso();
  run(`INSERT INTO change_requests(id,employee_id,shift_id,request_type,requested_date,requested_start,requested_end,requested_breaks_json,reason,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'review',?,?,?)`,requestId,context.user.employee_id,shift?.id||null,type,dateOnly(body.requestedDate),requestedStart,requestedEnd,JSON.stringify(requestedBreaks),cleanText(body.reason,3000),context.user.id,now,now);audit(context.user.id,'request.created','request',requestId,{type},clientIp(req));writeJson(res,201,{id:requestId});
});

route('PUT','/api/requests/:id/review',async(req,res,params)=>{
  const context=requireAuth(req);requireCsrf(req,context);const request=row('SELECT * FROM change_requests WHERE id=?',params.id);if(!request) fail('Cererea nu există.',404);const employee=employeeOrFail(request.employee_id);if(!canReviewEmployee(context.user,employee)) fail('Nu ai dreptul să verifici această cerere.',403);const body=await readJson(req,config.maxJsonBytes);if(!['approved','declined'].includes(body.status)) fail('Decizia este invalidă.');
  const start=timeOnly(body.requestedStart)||request.requested_start,end=timeOnly(body.requestedEnd)||request.requested_end;let breaks=body.breaks!==undefined?validateRequestBreaks(start||shiftOrFail(request.shift_id).start_time,end||shiftOrFail(request.shift_id).end_time,body.breaks):parseJson(request.requested_breaks_json,[]);const updated={...request,requested_date:dateOnly(body.requestedDate)||request.requested_date,requested_start:start,requested_end:end,requested_breaks_json:JSON.stringify(breaks)};
  transaction(()=>{run(`UPDATE change_requests SET requested_date=?,requested_start=?,requested_end=?,requested_breaks_json=?,status=?,manager_note=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?`,updated.requested_date,updated.requested_start,updated.requested_end,updated.requested_breaks_json,body.status,cleanText(body.managerNote,3000),context.user.id,nowIso(),nowIso(),request.id);if(body.status==='approved')applyApprovedRequest(updated);audit(context.user.id,`request.${body.status}`,'request',request.id,{employeeId:employee.id},clientIp(req));});writeJson(res,200,{ok:true});
});

function createInviteForUser(req, actor, userId) {
  run('UPDATE invitations SET used_at=? WHERE user_id=? AND used_at IS NULL',nowIso(),userId);
  const token=randomToken(),inviteId=id(),expiresAt=new Date(Date.now()+config.inviteDays*86400000).toISOString();run(`INSERT INTO invitations(id,user_id,token_hash,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?)`,inviteId,userId,sha256(token),expiresAt,actor.id,nowIso());return{token,url:`${requestOrigin(req)}/?invite=${encodeURIComponent(token)}`,expiresAt};
}

route('POST','/api/users',async(req,res)=>{
  const context=requireAuth(req);requireCsrf(req,context);requireAdmin(context);const body=await readJson(req,config.maxJsonBytes);const role=body.role;if(!validRole(role)) fail('Rol invalid.');const loginId=cleanText(body.loginId,64),cardId=cleanText(body.cardId,80);if(!/^[A-Za-z0-9._-]{4,32}$/.test(loginId)||!cardId) fail('ID sau Card ID invalid.');if(row('SELECT id FROM users WHERE login_id=? COLLATE NOCASE OR card_id=? COLLATE NOCASE',loginId,cardId)) fail('ID-ul sau Card ID-ul este deja folosit.');
  let employee=null;if(body.employeeId){employee=employeeOrFail(body.employeeId);if(row('SELECT id FROM users WHERE employee_id=?',employee.id)) fail('Angajatul are deja un cont.');}if(role==='employee'&&!employee) fail('Rolul Employee necesită un angajat asociat.');if(['manager','team_leader'].includes(role)&&(!body.agencyId||!body.departmentId)) fail('Managerul și Team Leaderul necesită agenție și departament.');
  const userId=id(),now=nowIso();const source=employee?profileFromEmployee(employee,{}):{};run(`INSERT INTO users(id,login_id,display_name,card_id,role,agency_id,department_id,employee_id,email,phone,address,birth_date,emergency_name,emergency_phone,language,notifications,personal_note,photo_data,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,userId,loginId,cleanText(source.display_name||body.displayName,120),cardId,role,role==='admin'||role==='planner'?null:(source.agency_id||body.agencyId||null),role==='admin'||role==='planner'?null:(source.department_id||body.departmentId||null),employee?.id||null,cleanText(source.email||body.email,200),cleanText(source.phone||body.phone,80),cleanText(source.address||body.address,500),source.birth_date||dateOnly(body.birthDate),cleanText(source.emergency_name||body.emergencyName,120),cleanText(source.emergency_phone||body.emergencyPhone,80),['ro','nl','en'].includes(body.language)?body.language:'ro',1,'',photo(source.photo_data||body.photoData),0,now,now);const invite=createInviteForUser(req,context.user,userId);audit(context.user.id,'user.created','user',userId,{loginId,role},clientIp(req));writeJson(res,201,{id:userId,inviteUrl:invite.url,expiresAt:invite.expiresAt});
});

route('PUT','/api/users/:id',async(req,res,params)=>{
  const context=requireAuth(req);requireCsrf(req,context);requireAdmin(context);const target=row('SELECT * FROM users WHERE id=?',params.id);if(!target) fail('Contul nu există.',404);const body=await readJson(req,config.maxJsonBytes);const role=body.role||target.role;if(!validRole(role)) fail('Rol invalid.');if(target.role==='admin'&&(role!=='admin'||body.active===false)){const others=row(`SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1 AND id<>?`,target.id).count;if(!others) fail('Trebuie să rămână cel puțin un Administrator activ.');}
  const loginId=cleanText(body.loginId??target.login_id,64),cardId=cleanText(body.cardId??target.card_id,80);if(!/^[A-Za-z0-9._-]{4,32}$/.test(loginId)||!cardId) fail('ID sau Card ID invalid.');if(row('SELECT id FROM users WHERE (login_id=? COLLATE NOCASE OR card_id=? COLLATE NOCASE) AND id<>?',loginId,cardId,target.id)) fail('ID-ul sau Card ID-ul este deja folosit.');
  transaction(()=>{run(`UPDATE users SET login_id=?,display_name=?,card_id=?,role=?,agency_id=?,department_id=?,employee_id=?,email=?,phone=?,address=?,birth_date=?,emergency_name=?,emergency_phone=?,language=?,notifications=?,personal_note=?,photo_data=?,active=?,failed_attempts=?,locked_until=?,updated_at=? WHERE id=?`,loginId,cleanText(body.displayName??target.display_name,120),cardId,role,['admin','planner'].includes(role)?null:(body.agencyId??target.agency_id),['admin','planner'].includes(role)?null:(body.departmentId??target.department_id),body.employeeId===undefined?target.employee_id:(body.employeeId||null),cleanText(body.email??target.email,200),cleanText(body.phone??target.phone,80),cleanText(body.address??target.address,500),dateOnly(body.birthDate)||target.birth_date,cleanText(body.emergencyName??target.emergency_name,120),cleanText(body.emergencyPhone??target.emergency_phone,80),['ro','nl','en'].includes(body.language)?body.language:target.language,bool(body.notifications??target.notifications),cleanText(body.personalNote??target.personal_note,2000),photo(body.photoData===undefined?target.photo_data:body.photoData),bool(body.active??target.active),body.unlock?0:target.failed_attempts,body.unlock?null:target.locked_until,nowIso(),target.id);if(body.newPassword){if(!validPassword(body.newPassword)) fail('Parola nouă nu respectă cerințele.');const password=passwordRecord(body.newPassword);run('UPDATE users SET password_hash=?,password_salt=?,must_change_password=1 WHERE id=?',password.hash,password.salt,target.id);}audit(context.user.id,'user.updated','user',target.id,{role,active:body.active??target.active},clientIp(req));});writeJson(res,200,{ok:true});
});

route('POST','/api/users/:id/invite',async(req,res,params)=>{
  const context=requireAuth(req);requireCsrf(req,context);requireAdmin(context);const target=row('SELECT * FROM users WHERE id=?',params.id);if(!target) fail('Contul nu există.',404);run('UPDATE users SET active=0,password_hash=NULL,password_salt=NULL,updated_at=? WHERE id=?',nowIso(),target.id);const invite=createInviteForUser(req,context.user,target.id);audit(context.user.id,'user.invite.regenerated','user',target.id,{},clientIp(req));writeJson(res,200,{inviteUrl:invite.url,expiresAt:invite.expiresAt});
});

route('POST','/api/vehicles',async(req,res)=>{
  const context=requireAuth(req);requireCsrf(req,context);requireAdmin(context);const body=await readJson(req,config.maxJsonBytes);const vehicleId=id(),now=nowIso();run('INSERT INTO vehicles(id,name,plate_number,seats,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',vehicleId,cleanText(body.name,120),cleanText(body.plateNumber,40),Math.max(1,Math.min(50,Number(body.seats||5))),1,now,now);audit(context.user.id,'vehicle.created','vehicle',vehicleId,{},clientIp(req));writeJson(res,201,{id:vehicleId});
});

route('POST','/api/car-trips',async(req,res)=>{
  const context=requireAuth(req);requireCsrf(req,context);if(!canManageCars(context.user)) fail('Nu ai dreptul să gestionezi transportul.',403);const body=await readJson(req,config.maxJsonBytes);const driver=employeeOrFail(body.driverEmployeeId);if(!canViewEmployee(context.user,driver)) fail('Șoferul nu este în aria ta de acces.',403);const tripId=id(),now=nowIso();transaction(()=>{run(`INSERT INTO car_trips(id,date,departure_time,driver_employee_id,vehicle_id,pickup_address,destination,driver_name_override,driver_address_override,driver_phone_override,note,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,tripId,dateOnly(body.date),timeOnly(body.departureTime),driver.id,body.vehicleId||null,cleanText(body.pickupAddress||driver.address,500),cleanText(body.destination,500),cleanText(body.driverNameOverride,120),cleanText(body.driverAddressOverride,500),cleanText(body.driverPhoneOverride,80),cleanText(body.note,1000),context.user.id,now,now);for(const employeeId of [...new Set(body.passengerIds||[])]){const passenger=employeeOrFail(employeeId);if(canViewEmployee(context.user,passenger))run('INSERT INTO car_trip_passengers(trip_id,employee_id) VALUES(?,?)',tripId,employeeId)}audit(context.user.id,'car_trip.created','car_trip',tripId,{driver:driver.id},clientIp(req));});writeJson(res,201,{id:tripId});
});

route('POST','/api/catalog/:type',async(req,res,params)=>{
  const context=requireAuth(req);requireCsrf(req,context);requireAdmin(context);const tables={agencies:'agencies',departments:'departments',positions:'positions'};const table=tables[params.type];if(!table) fail('Catalog invalid.');const body=await readJson(req,config.maxJsonBytes);const recordId=id(),now=nowIso();if(table==='agencies')run('INSERT INTO agencies(id,name,code,color,active,created_at) VALUES(?,?,?,?,1,?)',recordId,cleanText(body.name,120),cleanText(body.code,30),cleanText(body.color,20)||'#0875dc',now);else run(`INSERT INTO ${table}(id,name,color,active,created_at) VALUES(?,?,?,1,?)`,recordId,cleanText(body.name,120),cleanText(body.color,20)||'#0875dc',now);audit(context.user.id,'catalog.created',table,recordId,{},clientIp(req));writeJson(res,201,{id:recordId});
});

route('PUT','/api/catalog/:type/:id',async(req,res,params)=>{
  const context=requireAuth(req);requireCsrf(req,context);requireAdmin(context);const tables={agencies:'agencies',departments:'departments',positions:'positions'};const table=tables[params.type];if(!table) fail('Catalog invalid.');const body=await readJson(req,config.maxJsonBytes);if(table==='agencies')run('UPDATE agencies SET name=?,code=?,color=?,active=? WHERE id=?',cleanText(body.name,120),cleanText(body.code,30),cleanText(body.color,20)||'#0875dc',bool(body.active),params.id);else run(`UPDATE ${table} SET name=?,color=?,active=? WHERE id=?`,cleanText(body.name,120),cleanText(body.color,20)||'#0875dc',bool(body.active),params.id);audit(context.user.id,'catalog.updated',table,params.id,{},clientIp(req));writeJson(res,200,{ok:true});
});

route('POST','/api/admin/actions',async(req,res)=>{
  const context=requireAuth(req);requireCsrf(req,context);requireAdmin(context);const body=await readJson(req,config.maxJsonBytes);let affected=0;
  if(body.action==='publish_all'){affected=run(`UPDATE shifts SET status='published',updated_at=? WHERE status='draft'`,nowIso()).changes}
  else if(body.action==='unlock_all'){affected=run('UPDATE users SET failed_attempts=0,locked_until=NULL').changes}
  else if(body.action==='activate_all'){affected=run('UPDATE users SET active=1').changes}
  else if(body.action==='delete_resolved'){affected=run(`DELETE FROM change_requests WHERE status IN ('approved','declined')`).changes}
  else if(body.action==='approve_all'){const pending=rows(`SELECT * FROM change_requests WHERE status='review'`);transaction(()=>{for(const request of pending){applyApprovedRequest(request);run(`UPDATE change_requests SET status='approved',manager_note='Aprobat global de Administrator',reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?`,context.user.id,nowIso(),nowIso(),request.id)}affected=pending.length})}
  else if(body.action==='repair_breaks'){const shifts=rows('SELECT * FROM shifts');transaction(()=>{for(const shift of shifts){if(!validateBreaks(shift.start_time,shift.end_time,shiftBreaks(shift.id)).valid){saveShiftBreaks(shift.id,normalizeBreakInput(shift.start_time,shift.end_time,defaultBreaks(shift.start_time,shift.end_time),false));affected++}}})}
  else if(body.action==='backup'){createBackup('manual');affected=1}
  else fail('Acțiune administrativă invalidă.');
  audit(context.user.id,`admin.${body.action}`,'system',null,{affected},clientIp(req));writeJson(res,200,{ok:true,affected,integrity:integrityReport(),backups:listBackups()});
});

route('GET','/api/admin/backup',async(req,res)=>{
  const context=requireAuth(req);requireAdmin(context);const backup={version:'2.0.0',createdAt:nowIso(),agencies:rows('SELECT * FROM agencies'),departments:rows('SELECT * FROM departments'),positions:rows('SELECT * FROM positions'),employees:rows('SELECT * FROM employees'),users:rows('SELECT * FROM users').map(userPublic),shifts:rows('SELECT * FROM shifts').map(shiftWithBreaks),attendance:rows('SELECT * FROM attendance'),requests:rows('SELECT * FROM change_requests').map(requestWithBreaks),vehicles:rows('SELECT * FROM vehicles'),carTrips:rows('SELECT * FROM car_trips').map(trip=>({...trip,passenger_ids:rows('SELECT employee_id FROM car_trip_passengers WHERE trip_id=?',trip.id).map(item=>item.employee_id)})),audit:rows('SELECT * FROM audit_log')};audit(context.user.id,'admin.backup.downloaded','system',null,{},clientIp(req));const body=JSON.stringify(backup,null,2);res.writeHead(200,{...baseHeaders,'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="kivits-backup-${new Date().toISOString().slice(0,10)}.json"`,'Content-Length':Buffer.byteLength(body)});res.end(body);
});

function serveStatic(req,res,urlPath){
  let relative=urlPath==='/'?'index.html':decodeURIComponent(urlPath.slice(1));
  const safe=normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
  let file=join(config.publicDir,safe);
  if(!file.startsWith(config.publicDir)) return false;
  if(!existsSync(file)||statSync(file).isDirectory()){if(extname(safe))return false;file=join(config.publicDir,'index.html')}
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.ico':'image/x-icon'};const type=types[extname(file).toLowerCase()]||'application/octet-stream';const stat=statSync(file);res.writeHead(200,{...baseHeaders,'Content-Type':type,'Content-Length':stat.size,'Cache-Control':extname(file)==='.html'?'no-cache':'public, max-age=3600'});createReadStream(file).pipe(res);return true;
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')){
      for(const item of routes){if(item.method!==req.method)continue;const match=url.pathname.match(item.regex);if(!match)continue;const params={};item.keys.forEach((key,index)=>params[key]=decodeURIComponent(match[index+1]));await item.handler(req,res,params);return}
      fail('Endpoint inexistent.',404);
    }
    if(!['GET','HEAD'].includes(req.method))fail('Metodă nepermisă.',405);
    if(!serveStatic(req,res,url.pathname))fail('Fișier inexistent.',404);
  }catch(error){if(!res.headersSent)errorResponse(res,error);else res.destroy()}
});

server.listen(config.port,config.host,()=>{
  console.log(`Kivit's Goes Uren Online 2.0 listening on http://${config.host}:${config.port}`);
  console.log(`Database: ${config.databasePath}`);
});

if(config.autoBackupHours>0){
  const timer=setInterval(()=>{try{createBackup('automatic')}catch(error){console.error('Automatic backup failed',error)}},config.autoBackupHours*3600000);timer.unref();
}

for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close()}finally{server.close(()=>process.exit(0))}});
