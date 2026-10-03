import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

export const DATA = path.join(ROOT, 'data');
export const PATHS = {
  root: ROOT,
  data: DATA,
  // Overridable so the test suite never touches the live database. Tests that
  // write applications and steps were polluting the real queue with fixtures.
  db: process.env['SPANI_DB'] ?? path.join(DATA, 'spani.db'),
  profileDir: path.join(DATA, 'profile'),
  masterProfile: path.join(DATA, 'profile', 'master.yaml'),
  answers: path.join(DATA, 'profile', 'answers.yaml'),
  documents: path.join(DATA, 'documents'),
  manifest: path.join(DATA, 'documents', 'manifest.yaml'),
  generated: path.join(DATA, 'generated'),
  browserProfile: path.join(DATA, 'browser-profile'),
  artifacts: path.join(DATA, 'artifacts'),
  logs: path.join(DATA, 'logs'),
  secrets: path.join(DATA, 'secrets.enc'),
  migrations: path.join(ROOT, 'src', 'db', 'migrations'),
  fixtures: path.join(ROOT, 'fixtures'),
} as const;

/** Create every data directory. Safe to call repeatedly. */
export function ensureDataDirs(): void {
  for (const p of [
    PATHS.data, PATHS.profileDir, PATHS.documents, PATHS.generated,
    PATHS.browserProfile, PATHS.artifacts, PATHS.logs,
  ]) {
    fs.mkdirSync(p, { recursive: true });
  }
}

export function artifactDir(runId: string): string {
  const p = path.join(PATHS.artifacts, runId);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
