import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PATHS, ensureDataDirs } from './paths.js';
import { logger } from './logger.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  ensureDataDirs();
  db = new Database(PATHS.db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(conn: Database.Database): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    conn.prepare('SELECT version FROM schema_version').all().map((r) => (r as { version: number }).version),
  );

  const files = fs.existsSync(PATHS.migrations)
    ? fs.readdirSync(PATHS.migrations).filter((f) => f.endsWith('.sql')).sort()
    : [];

  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (Number.isNaN(version)) throw new Error(`Migration filename must start with 3 digits: ${file}`);
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(PATHS.migrations, file), 'utf8');
    const run = conn.transaction(() => {
      conn.exec(sql);
      conn.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(version, file);
    });
    run();
    logger.info({ migration: file }, 'applied migration');
  }
}

export function closeDb(): void {
  db?.close();
  db = null;
}
