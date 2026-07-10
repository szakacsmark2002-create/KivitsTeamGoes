import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const production = process.env.NODE_ENV === 'production';
const rootDir = resolve(import.meta.dirname, '..');
const dataDir = resolve(process.env.DATA_DIR || resolve(rootDir, 'data'));
const backupDir = resolve(process.env.BACKUP_DIR || resolve(dataDir, 'backups'));
mkdirSync(dataDir, { recursive: true });
mkdirSync(backupDir, { recursive: true });

export const config = Object.freeze({
  production,
  rootDir,
  publicDir: resolve(rootDir, 'public'),
  dataDir,
  backupDir,
  databasePath: resolve(process.env.DATABASE_PATH || resolve(dataDir, 'kivits-goes.sqlite')),
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  timezone: process.env.TZ || 'Europe/Amsterdam',
  appOrigin: process.env.APP_ORIGIN || '',
  cookieSecure: process.env.COOKIE_SECURE === 'true' || production,
  sessionHours: Number(process.env.SESSION_HOURS || 8),
  inviteDays: Number(process.env.INVITE_DAYS || 30),
  adminId: process.env.ADMIN_ID || 'Mark001',
  adminPassword: process.env.ADMIN_PASSWORD || 'Ciobycuy1',
  adminName: process.env.ADMIN_NAME || 'Mark',
  autoBackupHours: Number(process.env.AUTO_BACKUP_HOURS || 24),
  backupRetention: Number(process.env.BACKUP_RETENTION || 14),
  maxJsonBytes: Number(process.env.MAX_JSON_BYTES || 2_500_000),
});

if (production && !process.env.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD is required when NODE_ENV=production.');
}
