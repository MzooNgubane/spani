import { randomUUID } from 'node:crypto';
import { newPage, closeSession, screenshot } from '../browser/session.js';
import { snapshotPage } from '../browser/snapshot.js';
import { detectVerification } from '../browser/verification.js';
import { loadProfile } from '../profile/index.js';
import { mapFields } from './fieldmap.js';
import { applyFieldmap, summarise, type FillOutcome } from './filler.js';
import { logger } from '../core/logger.js';
import { getDb } from '../core/db.js';

/**
 * The whole pipeline, with nothing written to the page and nothing submitted.
 *
 * This is the mode every new site starts in. It answers the only question that
 * matters before we let the agent touch a real application: "does it know what
 * goes where, and does it correctly refuse the things it should refuse?"
 */

export interface DryRunResult {
  url: string;
  siteKey: string;
  signature: string;
  fields: number;
  cacheHit: boolean;
  costUsd: number;
  outcomes: FillOutcome[];
  rejected: Array<{ ref: string; why: string }>;
  verification: string | null;
  screenshotPath: string;
}

export function siteKeyFor(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '') || 'local';
  } catch {
    return 'local';
  }
}

export async function dryRun(url: string, opts: { fresh?: boolean } = {}): Promise<DryRunResult> {
  const runId = randomUUID();
  const profile = loadProfile();
  const siteKey = siteKeyFor(url);

  getDb().prepare(`INSERT INTO runs (id, kind, budget_usd) VALUES (?, 'APPLY', NULL)`).run(runId);

  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const verification = await detectVerification(page);
    const snap = await snapshotPage(page);
    const shot = await screenshot(page, runId, 'dryrun');

    const map = await mapFields(snap, {
      siteKey, profile, runId,
      ...(opts.fresh ? { fresh: true } : {}),
    });

    const outcomes = await applyFieldmap(map.mappings, {
      page, snapshot: snap, profile, dryRun: true,
    });
    summarise(outcomes);

    getDb().prepare(
      `UPDATE runs SET state = 'DONE', finished_at = datetime('now'), spent_usd = ? WHERE id = ?`,
    ).run(map.usage?.costUsd ?? 0, runId);

    return {
      url: page.url(), siteKey, signature: snap.signature, fields: snap.fields.length,
      cacheHit: map.cacheHit, costUsd: map.usage?.costUsd ?? 0,
      outcomes, rejected: map.rejected,
      verification: verification ? `${verification.kind} (${verification.evidence})` : null,
      screenshotPath: shot,
    };
  } catch (e) {
    getDb().prepare(`UPDATE runs SET state = 'FAILED', finished_at = datetime('now') WHERE id = ?`).run(runId);
    logger.error({ err: e instanceof Error ? e.message : String(e) }, 'dry run failed');
    throw e;
  } finally {
    await closeSession();
  }
}
