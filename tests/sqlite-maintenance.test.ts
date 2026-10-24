import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteBackup, pruneSqliteBackups, restoreSqliteBackup, verifySqliteBackup } from '../apps/cli/src/sqlite-maintenance.js';

const roots: string[] = [];
function sandbox(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'woori-db-test-'));roots.push(root);return root;}
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

describe('SQLite maintenance',()=>{
 it('backs up a live WAL database consistently and verifies integrity',async()=>{
  const root=sandbox(),source=path.join(root,'live.sqlite'),destination=path.join(root,'backups','woori-agent-2026-10-25T10-00-00-000Z.sqlite');
  const db=new Database(source);db.pragma('journal_mode = WAL');db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');db.prepare('INSERT INTO events(value) VALUES (?)').run('committed-in-wal');
  const result=await createSqliteBackup({source,destination});
  expect(result.integrity.ok).toBe(true);
  const snapshot=new Database(destination,{readonly:true});expect(snapshot.prepare('SELECT value FROM events').pluck().all()).toEqual(['committed-in-wal']);snapshot.close();db.close();
 });

 it('refuses backup and restore overwrite',async()=>{
  const root=sandbox(),source=path.join(root,'source.sqlite'),backup=path.join(root,'woori-agent-2026-10-25T10-00-00-000Z.sqlite'),target=path.join(root,'target.sqlite');
  const db=new Database(source);db.exec('CREATE TABLE t (n INTEGER)');db.close();
  await createSqliteBackup({source,destination:backup});
  await expect(createSqliteBackup({source,destination:backup})).rejects.toThrow(/already exists/);
  restoreSqliteBackup({backup,destination:target});
  expect(()=>restoreSqliteBackup({backup,destination:target})).toThrow(/already exists/);
  expect(verifySqliteBackup(target).ok).toBe(true);
 });

 it('prunes only recognized snapshots and supports dry-run',()=>{
  const root=sandbox();for(const name of ['woori-agent-2026-10-20T10-00-00-000Z.sqlite','woori-agent-2026-10-21T10-00-00-000Z.sqlite','keep-me.sqlite'])fs.writeFileSync(path.join(root,name),'snapshot');
  const preview=pruneSqliteBackups({directory:root,keepCount:1,apply:false});expect(preview.candidates).toHaveLength(1);expect(preview.removed).toEqual([]);expect(fs.existsSync(preview.candidates[0]!)).toBe(true);
  const applied=pruneSqliteBackups({directory:root,keepCount:1,apply:true});expect(applied.removed).toHaveLength(1);expect(fs.existsSync(path.join(root,'keep-me.sqlite'))).toBe(true);
 });
});
