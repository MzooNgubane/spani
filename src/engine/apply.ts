import { randomUUID, createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { getDb } from '../core/db.js';
import { logger } from '../core/logger.js';
import { loadConfig } from '../core/config.js';
import { newPage, closeSession, screenshot, jitter } from '../browser/session.js';
import { snapshotPage, type PageSnapshot } from '../browser/snapshot.js';
import { handleVerification, openTask } from '../hitl/broker.js';
import { loadProfile, type Profile } from '../profile/index.js';
import { mapFields, recordFieldmapOutcome, invalidateFieldmap } from './fieldmap.js';
import { applyFieldmap, type FillOutcome } from './filler.js';
import { generateAnswer } from './generate.js';
import { Journal, decideResume } from './journal.js';
import { siteKeyFor } from './dryrun.js';

/**
 * Drives one application to the point of submission - and stops there.
 *
 * PREPARE-THEN-REPLAY: we fill everything, capture the exact payload, then
 * abandon the browser session and park the application as AWAITING_APPROVAL.
 * On approval the payload is replayed deterministically with ZERO AI calls.
 *
 * That split is what makes "ask me before submitting" compatible with checking
 * in once a week. Holding a live browser session open for seven days is not a
 * thing; a stored payload keeps indefinitely.
 */

const MAX_PAGES = 12;

export interface ApplyOptions {
  url: string;
  title?: string;
  organisation?: string;
  type?: string;
  /** Actually type into the page. false = dry run. */
  live?: boolean;
}

export interface ApplyResult {
  applicationId: string;
  status: string;
  pagesProcessed: number;
  outcomes: FillOutcome[];
  costUsd: number;
  blockedBy: string | null;
  submitReady: boolean;
  screenshots: string[];
}

function canonical(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|ref|source)/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString();
  } catch { return url; }
}

/** Find or create the opportunity + application. UNIQUE is the duplicate guard. */
function ensureApplication(o: ApplyOptions): { applicationId: string; opportunityId: string; fresh: boolean } {
  const db = getDb();
  const canon = canonical(o.url);

  let opp = db.prepare('SELECT id FROM opportunities WHERE url_canonical = ?').get(canon) as
    { id: string } | undefined;
  if (!opp) {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO opportunities (id, source, url, url_canonical, title, organisation, type)
      VALUES (?, 'MANUAL', ?, ?, ?, ?, ?)
    `).run(id, o.url, canon, o.title ?? o.url, o.organisation ?? null, o.type ?? 'UNKNOWN');
    opp = { id };
  }

  const existing = db.prepare('SELECT id, status FROM applications WHERE opportunity_id = ?')
    .get(opp.id) as { id: string; status: string } | undefined;
  if (existing) return { applicationId: existing.id, opportunityId: opp.id, fresh: false };

  const appId = randomUUID();
  db.prepare(`
    INSERT INTO applications (id, opportunity_id, status, site_key, started_at)
    VALUES (?, ?, 'PREPARING', ?, datetime('now'))
  `).run(appId, opp.id, siteKeyFor(o.url));
  return { applicationId: appId, opportunityId: opp.id, fresh: true };
}

function setStatus(applicationId: string, status: string, extra: Record<string, unknown> = {}): void {
  getDb().prepare(
    `UPDATE applications SET status = ?, updated_at = datetime('now'),
       failure_reason = COALESCE(?, failure_reason) WHERE id = ?`,
  ).run(status, (extra['failureReason'] as string) ?? null, applicationId);
}

/** Buttons that advance a multi-page form, in preference order. */
const NEXT_WORDS = /^(next|continue|save (and|&) continue|proceed|forward)\b/i;
const SUBMIT_WORDS = /^(submit|send|apply now|finish|complete|confirm and submit)\b/i;

async function findAdvance(page: Page, snap: PageSnapshot):
Promise<{ kind: 'NEXT' | 'SUBMIT'; label: string } | null> {
  for (const b of snap.buttons) if (NEXT_WORDS.test(b.label.trim())) return { kind: 'NEXT', label: b.label };
  for (const b of snap.buttons) if (SUBMIT_WORDS.test(b.label.trim())) return { kind: 'SUBMIT', label: b.label };
  return null;
}

export async function apply(o: ApplyOptions): Promise<ApplyResult> {
  const cfg = loadConfig();
  const profile: Profile = loadProfile();
  const runId = randomUUID();
  const { applicationId } = ensureApplication(o);
  const journal = new Journal(applicationId);
  const siteKey = siteKeyFor(o.url);

  const decision = decideResume(journal);
  if (decision.action === 'ALREADY_DONE') {
    return { applicationId, status: 'SUBMITTED', pagesProcessed: 0, outcomes: [],
      costUsd: 0, blockedBy: null, submitReady: false, screenshots: [] };
  }
  if (decision.action === 'ASK_HUMAN') {
    openTask({
      kind: 'SUBMIT_UNCERTAIN', urgency: 'URGENT', applicationId,
      prompt: decision.reason, context: { url: o.url, step: decision.step.seq },
    });
    setStatus(applicationId, 'HUMAN_ACTION_REQUIRED');
    return { applicationId, status: 'HUMAN_ACTION_REQUIRED', pagesProcessed: 0, outcomes: [],
      costUsd: 0, blockedBy: decision.reason, submitReady: false, screenshots: [] };
  }

  getDb().prepare(`INSERT INTO runs (id, kind, budget_usd) VALUES (?, 'APPLY', ?)`)
    .run(runId, cfg.budget.perRunUsd);

  const allOutcomes: FillOutcome[] = [];
  const screenshots: string[] = [];
  let costUsd = 0;
  let pages = 0;
  let blockedBy: string | null = null;
  let submitReady = false;

  const page = await newPage();
  try {
    const nav = journal.begin('NAVIGATE', { url: o.url });
    await page.goto(o.url, { waitUntil: 'domcontentloaded' });
    journal.finish(nav, 'DONE', { landedOn: page.url() });
    setStatus(applicationId, 'IN_PROGRESS');

    while (pages < MAX_PAGES) {
      pages++;

      // ── Human verification, every page, before anything else ──────
      const vstep = journal.begin('VERIFY_HUMAN', { page: pages }, page.url());
      const hv = await handleVerification(page, { runId, applicationId });
      if (hv.handled && !hv.resumed) {
        journal.finish(vstep, 'BLOCKED', { kind: hv.kind }, hv.reason);
        setStatus(applicationId, 'HUMAN_ACTION_REQUIRED');
        blockedBy = `${hv.kind}: ${hv.reason}`;
        break;
      }
      journal.finish(vstep, hv.handled ? 'DONE' : 'SKIPPED',
        hv.handled ? { kind: hv.kind, waitedMs: hv.waitedMs } : undefined);

      // A cleared challenge often lands you somewhere else entirely.
      const snapStep = journal.begin('SNAPSHOT', { page: pages }, page.url());
      let snap = await snapshotPage(page);
      journal.finish(snapStep, 'DONE', { fields: snap.fields.length, signature: snap.signature });
      screenshots.push(await screenshot(page, runId, `p${pages}`));

      if (!snap.fields.length) {
        logger.info({ page: pages, url: page.url() }, 'no form fields on this page');
        const adv = await findAdvance(page, snap);
        if (!adv) break;
        await page.getByRole('button', { name: adv.label, exact: false }).first().click().catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        continue;
      }

      // ── Map ───────────────────────────────────────────────────────
      const map = await mapFields(snap, { siteKey, profile, runId, applicationId });
      costUsd += map.usage?.costUsd ?? 0;

      // ── Generate the free-text answers this page needs ─────────────
      const generated = new Map<string, string>();
      for (const m of map.mappings.filter((x) => x.action === 'GENERATE')) {
        const gstep = journal.begin('GENERATE', { ref: m.ref, question: m.question });
        const g = await generateAnswer({
          question: m.question!, maxWords: m.max_words ?? 200, profile, runId, applicationId,
          ...(o.organisation ? { organisation: o.organisation } : {}),
          ...(o.title ? { opportunityTitle: o.title } : {}),
        });
        costUsd += g.costUsd;
        if (g.validatorPassed) {
          generated.set(m.ref, g.answer);
          journal.finish(gstep, 'DONE', { words: g.answer.split(/\s+/).length, reused: g.reused });
        } else {
          // Never submit prose we could not verify against the profile.
          journal.finish(gstep, 'BLOCKED', { notes: g.validatorNotes }, 'fact validation failed');
          openTask({
            kind: 'MISSING_ANSWER', urgency: 'NORMAL', applicationId,
            prompt: `I could not write a verifiable answer to: "${m.question}". ` +
              `Unsupported claims: ${g.validatorNotes.join('; ')}`,
            context: { ref: m.ref, draft: g.answer },
          });
        }
      }

      // ── Fill ──────────────────────────────────────────────────────
      const fstep = journal.begin('FILL', { page: pages, fields: snap.fields.length }, page.url());
      let outcomes = await applyFieldmap(map.mappings, {
        page, snapshot: snap, profile, applicationId, stepId: fstep.id, generated,
        ...(o.live ? {} : { dryRun: true }),
      });

      // One retry against a re-read page: a failed read-back is often a
      // re-render, not a real failure.
      if (o.live && outcomes.some((x) => x.status === 'FAILED')) {
        await jitter(600);
        snap = await snapshotPage(page);
        const retry = await applyFieldmap(
          map.mappings.filter((m) => outcomes.find((x) => x.ref === m.ref)?.status === 'FAILED'),
          { page, snapshot: snap, profile, applicationId, stepId: fstep.id, generated },
        );
        outcomes = outcomes.map((x) => retry.find((r) => r.ref === x.ref) ?? x);
      }

      allOutcomes.push(...outcomes);
      const failed = outcomes.filter((x) => x.status === 'FAILED').length;
      journal.finish(fstep, failed ? 'FAILED' : 'DONE', {
        filled: outcomes.filter((x) => x.status === 'FILLED').length,
        escalated: outcomes.filter((x) => x.status === 'ESCALATED').length,
        failed,
      });

      if (failed) {
        // A stale cached map is the usual cause; drop it so the next run re-asks.
        if (map.cacheHit) invalidateFieldmap(siteKey, snap.signature);
        else recordFieldmapOutcome(siteKey, snap.signature, false);
      } else {
        recordFieldmapOutcome(siteKey, snap.signature, true);
      }

      const escalations = outcomes.filter((x) => x.status === 'ESCALATED');
      if (escalations.length) {
        openTask({
          kind: 'MISSING_ANSWER', urgency: 'NORMAL', applicationId,
          prompt: `${escalations.length} field(s) on "${snap.title}" need you: ` +
            escalations.slice(0, 5).map((e) => `"${e.label}" (${e.reason})`).join('; '),
          context: { url: page.url(), refs: escalations.map((e) => e.ref) },
        });
      }

      // ── Advance, or stop at the submit gate ───────────────────────
      const adv = await findAdvance(page, snap);
      if (!adv) { logger.info({ page: pages }, 'no next or submit button - stopping'); break; }

      if (adv.kind === 'SUBMIT') {
        submitReady = true;
        logger.info({ label: adv.label }, 'reached the submit gate - stopping, as configured');
        break;
      }

      const nstep = journal.begin('NEXT_PAGE', { label: adv.label }, page.url());
      if (o.live) {
        await page.getByRole('button', { name: adv.label, exact: false }).first().click()
          .catch(() => page.click(`text=${adv.label}`).catch(() => {}));
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await jitter(500);
        journal.finish(nstep, 'DONE', { nowAt: page.url() });
      } else {
        journal.finish(nstep, 'SKIPPED', { wouldClick: adv.label });
        break;
      }
    }

    // ── Freeze the payload for later replay ────────────────────────
    const blockers = allOutcomes.filter((x) => x.status === 'ESCALATED' || x.status === 'FAILED');
    const status = blockedBy ? 'HUMAN_ACTION_REQUIRED'
      : blockers.length ? 'NEEDS_REVIEW'
        : submitReady ? 'AWAITING_APPROVAL' : 'IN_PROGRESS';

    if (status === 'AWAITING_APPROVAL' || status === 'NEEDS_REVIEW') {
      getDb().prepare(`
        UPDATE applications SET replay_payload_json = ?, replay_prepared_at = datetime('now'),
          risk_tier = ?, cost_usd = ?, status = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        JSON.stringify({ url: o.url, outcomes: allOutcomes, preparedAt: new Date().toISOString(),
          payloadHash: createHash('sha256').update(JSON.stringify(allOutcomes)).digest('hex').slice(0, 16) }),
        allOutcomes.some((x) => x.valueSource === 'GENERATED') ? 'AMBER' : 'AMBER',
        costUsd, status, applicationId,
      );
    } else {
      setStatus(applicationId, status);
    }

    getDb().prepare(
      `UPDATE runs SET state = 'DONE', finished_at = datetime('now'), spent_usd = ? WHERE id = ?`,
    ).run(costUsd, runId);

    return { applicationId, status, pagesProcessed: pages, outcomes: allOutcomes,
      costUsd, blockedBy, submitReady, screenshots };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(applicationId, 'FAILED', { failureReason: msg });
    getDb().prepare(`UPDATE runs SET state = 'FAILED', finished_at = datetime('now') WHERE id = ?`).run(runId);
    logger.error({ err: msg, applicationId }, 'apply failed');
    throw e;
  } finally {
    await closeSession();
  }
}
