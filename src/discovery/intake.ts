import { randomUUID, createHash } from 'node:crypto';
import { getDb } from '../core/db.js';
import { logger } from '../core/logger.js';
import { newPage, closeSession } from '../browser/session.js';
import { loadProfile } from '../profile/index.js';
import { assess, explain, type Assessment, type Extraction } from '../eligibility/index.js';

/**
 * Manual opportunity intake - Tier 1 discovery.
 *
 * Deliberately the first thing built and the last thing automated. A curated
 * list of twenty real funders beats a scraper that finds two hundred pages of
 * which most are closed, duplicated or not applicable. Broad discovery gets
 * built once this is provably working.
 */

export interface IntakeInput {
  url: string;
  title?: string;
  organisation?: string;
  type?: string;
  closingDate?: string;
  /** Skip fetching and use this text as the advert. */
  description?: string;
}

export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|ref|source)/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch { return url; }
}

/** Visible text of the advert, capped. Enough for criteria extraction. */
async function fetchDescription(url: string): Promise<string> {
  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1200);
    return await page.evaluate(`(() => {
      for (const sel of ['script','style','nav','footer','header','noscript','svg']) {
        document.querySelectorAll(sel).forEach((e) => e.remove());
      }
      return (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 14000);
    })()`) as string;
  } finally {
    await closeSession();
  }
}

export interface IntakeResult {
  opportunityId: string;
  fresh: boolean;
  assessment: Assessment & { extraction: Extraction };
  explanation: string;
}

export async function intake(input: IntakeInput): Promise<IntakeResult> {
  const db = getDb();
  const profile = loadProfile();
  const canon = canonicalUrl(input.url);

  const description = input.description ?? await fetchDescription(input.url);
  const contentHash = createHash('sha256').update(description).digest('hex').slice(0, 24);

  const existing = db.prepare('SELECT id FROM opportunities WHERE url_canonical = ?')
    .get(canon) as { id: string } | undefined;

  let opportunityId: string;
  if (existing) {
    opportunityId = existing.id;
    db.prepare(`UPDATE opportunities SET last_seen_at = datetime('now'), content_hash = ?,
      description_raw = ? WHERE id = ?`).run(contentHash, description, opportunityId);
  } else {
    opportunityId = randomUUID();
    db.prepare(`
      INSERT INTO opportunities (id, source, url, url_canonical, title, organisation, type,
        closing_date, description_raw, content_hash)
      VALUES (?, 'MANUAL', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(opportunityId, input.url, canon, input.title ?? input.url,
      input.organisation ?? null, input.type ?? 'UNKNOWN', input.closingDate ?? null,
      description, contentHash);
  }

  const assessment = await assess(description, profile, { opportunityId });

  // Record the verdict so the nightly run can pick up what is worth doing.
  const status = assessment.verdict === 'ELIGIBLE' ? 'ELIGIBLE'
    : assessment.verdict === 'NOT_ELIGIBLE' ? 'NOT_ELIGIBLE' : 'NEEDS_REVIEW';

  const hasApplication = db.prepare('SELECT id FROM applications WHERE opportunity_id = ?')
    .get(opportunityId);
  if (!hasApplication) {
    db.prepare(`INSERT INTO applications (id, opportunity_id, status) VALUES (?, ?, ?)`)
      .run(randomUUID(), opportunityId, status);
  }

  // Fill in whatever the advert told us that we did not already know.
  const ex = assessment.extraction;
  db.prepare(`
    UPDATE opportunities SET
      title = COALESCE(NULLIF(?, ''), title),
      organisation = COALESCE(organisation, ?),
      type = CASE WHEN type = 'UNKNOWN' THEN ? ELSE type END,
      closing_date = COALESCE(closing_date, ?),
      requirements_json = ?
    WHERE id = ?
  `).run(input.title ?? ex.title ?? '', ex.organisation ?? null, ex.type,
    input.closingDate ?? ex.closing_date ?? null,
    JSON.stringify(ex.criteria), opportunityId);

  logger.info({ url: canon, verdict: assessment.verdict, criteria: ex.criteria.length },
    'opportunity taken in');

  return {
    opportunityId, fresh: !existing, assessment,
    explanation: explain(assessment, input.title ?? ex.title ?? canon),
  };
}
