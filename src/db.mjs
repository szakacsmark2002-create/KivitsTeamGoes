import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { passwordRecord } from './security.mjs';

export const db = new DatabaseSync(config.databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

const schema = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#0875dc',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#0875dc',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#0875dc',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  personnel_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  card_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  birth_date TEXT,
  emergency_name TEXT NOT NULL DEFAULT '',
  emergency_phone TEXT NOT NULL DEFAULT '',
  agency_id TEXT NOT NULL REFERENCES agencies(id),
  department_id TEXT NOT NULL REFERENCES departments(id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  photo_data TEXT,
  contract_type TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  weekly_hours REAL NOT NULL DEFAULT 40,
  certifications_json TEXT NOT NULL DEFAULT '[]',
  skills_json TEXT NOT NULL DEFAULT '[]',
  preferred_language TEXT NOT NULL DEFAULT 'nl',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  password_salt TEXT,
  display_name TEXT NOT NULL,
  card_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('admin','planner','manager','team_leader','coordinator','viewer','employee')),
  agency_id TEXT REFERENCES agencies(id),
  department_id TEXT REFERENCES departments(id),
  employee_id TEXT UNIQUE REFERENCES employees(id),
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  birth_date TEXT,
  emergency_name TEXT NOT NULL DEFAULT '',
  emergency_phone TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'ro',
  notifications INTEGER NOT NULL DEFAULT 1,
  personal_note TEXT NOT NULL DEFAULT '',
  photo_data TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft','published','cancelled')),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(employee_id, date, start_time)
);
CREATE INDEX IF NOT EXISTS shifts_date_idx ON shifts(date);
CREATE INDEX IF NOT EXISTS shifts_employee_idx ON shifts(employee_id,date);
CREATE TABLE IF NOT EXISTS shift_breaks (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shift_breaks_shift_idx ON shift_breaks(shift_id,sort_order);
CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
  clock_in_actual TEXT NOT NULL,
  clock_in_calculated TEXT NOT NULL,
  clock_out_actual TEXT,
  clock_out_calculated TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attendance_employee_idx ON attendance(employee_id,clock_in_actual);
CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
  request_type TEXT NOT NULL CHECK(request_type IN ('hours','break','schedule','leave','profile')),
  requested_date TEXT,
  requested_start TEXT,
  requested_end TEXT,
  requested_breaks_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'review' CHECK(status IN ('review','approved','declined')),
  manager_note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS change_requests_employee_idx ON change_requests(employee_id,status);
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plate_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  seats INTEGER NOT NULL DEFAULT 5,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS car_trips (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  departure_time TEXT NOT NULL,
  driver_employee_id TEXT NOT NULL REFERENCES employees(id),
  vehicle_id TEXT REFERENCES vehicles(id),
  pickup_address TEXT NOT NULL,
  destination TEXT NOT NULL,
  driver_name_override TEXT NOT NULL DEFAULT '',
  driver_address_override TEXT NOT NULL DEFAULT '',
  driver_phone_override TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS car_trips_date_idx ON car_trips(date);
CREATE TABLE IF NOT EXISTS car_trip_passengers (
  trip_id TEXT NOT NULL REFERENCES car_trips(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY(trip_id,employee_id)
);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invitations_hash_idx ON invitations(token_hash);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at DESC);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
`;

db.exec(schema);
db.prepare(`INSERT INTO schema_meta(key,value) VALUES('version','2.0.0') ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();

export function nowIso() {
  return new Date().toISOString();
}

export function id() {
  return randomUUID();
}

export function transaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function row(sql, ...params) {
  return db.prepare(sql).get(...params) || null;
}

export function rows(sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

export function audit(actorId, action, entity = '', entityId = null, details = {}, ip = '') {
  db.prepare(`INSERT INTO audit_log(actor_id,action,entity,entity_id,details_json,ip,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(actorId || null, action, entity, entityId || null, JSON.stringify(details || {}), ip || '', nowIso());
}

function seedCatalog(table, records) {
  const statement = db.prepare(`INSERT INTO ${table}(id,name,${table === 'agencies' ? 'code,' : ''}color,active,created_at) VALUES(${table === 'agencies' ? '?,?,?,?,?,?' : '?,?,?,?,?'}) ON CONFLICT(name) DO NOTHING`);
  for (const record of records) {
    if (table === 'agencies') statement.run(record.id, record.name, record.code, record.color, 1, nowIso());
    else statement.run(record.id, record.name, record.color, 1, nowIso());
  }
}

seedCatalog('agencies', [{ id: 'agency-west-team', name: 'West Team', code: 'WEST', color: '#0875dc' }]);
seedCatalog('departments', [
  { id: 'dep-packing', name: 'Packing', color: '#1671c8' },
  { id: 'dep-warehouse', name: 'Warehouse', color: '#6b4fc1' },
  { id: 'dep-expeditie', name: 'Expeditie', color: '#bc7209' },
  { id: 'dep-quality', name: 'Quality', color: '#16845a' },
  { id: 'dep-cleaning', name: 'Cleaning', color: '#657080' },
]);
seedCatalog('positions', [
  { id: 'pos-productie', name: 'Productiemedewerker', color: '#c53a3f' },
  { id: 'pos-inpak', name: 'Inpakmedewerker', color: '#16845a' },
  { id: 'pos-reach', name: 'Reachtruckchauffeur', color: '#1468b5' },
  { id: 'pos-logistiek', name: 'Logistiek medewerker', color: '#a9660a' },
  { id: 'pos-quality', name: 'Kwaliteitscontroleur', color: '#6346b8' },
]);

if (!row('SELECT id FROM users LIMIT 1')) {
  const password = passwordRecord(config.adminPassword);
  const userId = id();
  db.prepare(`INSERT INTO users(
    id,login_id,password_hash,password_salt,display_name,card_id,role,language,active,must_change_password,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    userId, config.adminId, password.hash, password.salt, config.adminName, 'MARK-001', 'admin', 'ro', 1, 1, nowIso(), nowIso()
  );
  audit(userId, 'system.admin.seeded', 'user', userId, { loginId: config.adminId });
}

export function userPublic(user) {
  if (!user) return null;
  const copy = { ...user };
  delete copy.password_hash;
  delete copy.password_salt;
  copy.active = Boolean(copy.active);
  copy.notifications = Boolean(copy.notifications);
  copy.must_change_password = Boolean(copy.must_change_password);
  return copy;
}

export function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function createBackup(label = 'automatic') {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const safeLabel = String(label).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'backup';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(config.backupDir, `${stamp}-${safeLabel}.sqlite`);
  try {
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } catch {
    copyFileSync(config.databasePath, target);
  }
  const files = readdirSync(config.backupDir)
    .filter(name => name.endsWith('.sqlite'))
    .sort()
    .reverse();
  for (const old of files.slice(config.backupRetention)) rmSync(join(config.backupDir, old), { force: true });
  return basename(target);
}

export function listBackups() {
  if (!existsSync(config.backupDir)) return [];
  return readdirSync(config.backupDir).filter(name => name.endsWith('.sqlite')).sort().reverse();
}
