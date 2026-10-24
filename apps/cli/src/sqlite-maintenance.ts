import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type SqliteIntegrity = { ok: boolean; messages: string[]; bytes: number; sha256: string };

function ensureParent(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

export function inspectSqlite(filePath: string): SqliteIntegrity {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error('SQLite file does not exist.');
  const db = new Database(absolute, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const foreignKeyRows = db.pragma('foreign_key_check') as Array<Record<string, unknown>>;
    const messages = rows.map(row => row.integrity_check);
    if (foreignKeyRows.length) messages.push(`foreign_key_check reported ${foreignKeyRows.length} violation(s)`);
    const bytes = fs.statSync(absolute).size, hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    const descriptor = fs.openSync(absolute, 'r');
    try { let offset = 0, read = 0; while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, offset)) > 0) { hash.update(buffer.subarray(0, read)); offset += read; } }
    finally { fs.closeSync(descriptor); }
    const sha256 = hash.digest('hex');
    return { ok: messages.length === 1 && messages[0] === 'ok', messages, bytes, sha256 };
  } finally { db.close(); }
}

/** Uses SQLite's online backup API so committed WAL pages are included consistently. */
export async function createSqliteBackup(input: { source: string; destination: string }): Promise<{ destination: string; integrity: SqliteIntegrity }> {
  const source = path.resolve(input.source), destination = path.resolve(input.destination);
  if (source === destination) throw new Error('Backup destination must differ from source.');
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('SQLite source does not exist.');
  ensureParent(path.dirname(destination));
  if (fs.existsSync(destination)) throw new Error('Backup destination already exists; refusing to overwrite.');
  const temporary = `${destination}.tmp-${randomUUID()}`;
  const db = new Database(source, { fileMustExist: true, timeout: 5000 });
  try { await db.backup(temporary); }
  catch (error) { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); throw error; }
  finally { db.close(); }
  try {
    const integrity = inspectSqlite(temporary);
    if (!integrity.ok) throw new Error(`Backup integrity check failed: ${integrity.messages.join('; ')}`);
    // A hard-link is atomic and fails if another process created the final name.
    fs.linkSync(temporary, destination);
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
    return { destination, integrity: inspectSqlite(destination) };
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function verifySqliteBackup(filePath: string): SqliteIntegrity {
  const result = inspectSqlite(filePath);
  if (!result.ok) throw new Error(`SQLite integrity check failed: ${result.messages.join('; ')}`);
  return result;
}

/** Restore only to a new path. Existing databases are never silently overwritten. */
export function restoreSqliteBackup(input: { backup: string; destination: string }): { destination: string; integrity: SqliteIntegrity } {
  const backup = path.resolve(input.backup), destination = path.resolve(input.destination);
  if (backup === destination) throw new Error('Restore destination must differ from backup.');
  const integrity = verifySqliteBackup(backup);
  ensureParent(path.dirname(destination));
  if (fs.existsSync(destination)) throw new Error('Restore destination already exists; move it aside explicitly before restoring.');
  const temporary = `${destination}.restore-${randomUUID()}`;
  try {
    fs.copyFileSync(backup, temporary, fs.constants.COPYFILE_EXCL);
    const restored = verifySqliteBackup(temporary);
    if (restored.sha256 !== integrity.sha256) throw new Error('Restored database digest differs from verified backup.');
    fs.linkSync(temporary, destination);
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
    return { destination, integrity: verifySqliteBackup(destination) };
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function pruneSqliteBackups(input: { directory: string; prefix?: string; keepCount: number; olderThanMs?: number; now?: number; apply: boolean }): { candidates: string[]; removed: string[] } {
  if (!Number.isInteger(input.keepCount) || input.keepCount < 1) throw new Error('keepCount must be a positive integer.');
  const directory = path.resolve(input.directory), prefix = input.prefix ?? 'woori-agent-';
  if (!fs.existsSync(directory)) return { candidates: [], removed: [] };
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const snapshotName = new RegExp(`^${escapedPrefix}[0-9T_Z-]+\\.sqlite$`);
  const files = fs.readdirSync(directory).filter(name => snapshotName.test(name))
    .map(name => ({ name, full: path.join(directory, name), stat: fs.statSync(path.join(directory, name)) }))
    .filter(item => item.stat.isFile()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const now = input.now ?? Date.now();
  const candidates = files.filter((item, index) => index >= input.keepCount || (input.olderThanMs !== undefined && now - item.stat.mtimeMs > input.olderThanMs));
  const removed: string[] = [];
  if (input.apply) for (const item of candidates) { fs.unlinkSync(item.full); removed.push(item.full); }
  return { candidates: candidates.map(item => item.full), removed };
}
