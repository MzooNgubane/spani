import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Runs the suite against a throwaway database.
 *
 * The journal and duplicate-guard tests insert real applications and steps.
 * Pointed at data/spani.db they filled the live queue with "Test opportunity"
 * rows, which is both noise and a genuine hazard: the agent works from that
 * queue.
 */
const dir = mkdtempSync(path.join(tmpdir(), 'spani-test-'));
const dbPath = path.join(dir, 'test.db');

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', 'tests/**/*.test.ts'],
  { stdio: 'inherit', env: { ...process.env, SPANI_DB: dbPath } },
);

try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(result.status ?? 1);
