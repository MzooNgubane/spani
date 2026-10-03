import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDataDirs } from '../core/paths.js';
import {
  PROFILE_TEMPLATE, MANIFEST_TEMPLATE, CONFIG_TEMPLATE, DATA_README,
} from './templates.js';

/**
 * First-run setup.
 *
 * Writes starter files and never overwrites one that already exists - this
 * has to be safe to run twice, because people will.
 */

export interface InitResult {
  created: string[];
  skipped: string[];
}

function writeIfAbsent(file: string, contents: string, r: InitResult): void {
  const rel = path.relative(PATHS.root, file);
  if (fs.existsSync(file)) { r.skipped.push(rel); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
  r.created.push(rel);
}

export function init(): InitResult {
  const r: InitResult = { created: [], skipped: [] };
  ensureDataDirs();

  for (const sub of ['identity', 'academic', 'personal', 'cv', 'motivation', 'financial', 'family']) {
    fs.mkdirSync(path.join(PATHS.documents, sub), { recursive: true });
  }

  writeIfAbsent(
    PATHS.masterProfile,
    PROFILE_TEMPLATE.replace('REPLACE_DATE', new Date().toISOString().slice(0, 10)),
    r,
  );
  writeIfAbsent(
    PATHS.manifest,
    MANIFEST_TEMPLATE.replace('REPLACE_SOURCE_DIR', PATHS.documents.replace(/\\/g, '\\\\')),
    r,
  );
  writeIfAbsent(path.join(PATHS.root, 'spani.config.json'), CONFIG_TEMPLATE, r);
  writeIfAbsent(path.join(PATHS.data, 'README.md'), DATA_README, r);
  writeIfAbsent(
    PATHS.answers,
    '# Answers you have written and approved, reused across applications.\n' +
    '# The agent adds to this as you resolve questions.\n\nanswers: []\n',
    r,
  );

  return r;
}

/** Ordered, specific next steps. Printed after init and by `doctor` on failure. */
export function nextSteps(): string[] {
  return [
    'Install a browser:        npx playwright install chromium   (or use installed Chrome)',
    'Fill in your facts:       data/profile/master.yaml',
    'Copy your documents into: data/documents/<category>/',
    'Describe them:            data/documents/manifest.yaml',
    'Load them:                npm run spani -- ingest',
    'See what is still needed: npm run spani -- review',
    'Check everything works:   npm run doctor',
  ];
}
