import { randomUUID } from 'node:crypto';
import type { Page, Locator } from 'playwright';
import { getDb } from '../core/db.js';
import { logger } from '../core/logger.js';
import { jitter } from '../browser/session.js';
import type { Field, PageSnapshot } from '../browser/snapshot.js';
import { resolve, isKnown, isSensitivePath, type Profile } from '../profile/index.js';
import { matchDocument } from '../documents/index.js';
import type { Mapping } from './fieldmap.js';

/**
 * Applies a fieldmap to a live page. Fully deterministic - no AI here.
 *
 * Every write is read back and compared. A field that did not take the value
 * (masked input, JS reformatting, a React state that ignored the event) is a
 * failure, not a success: submitting a form you believe is filled but is not
 * is worse than not submitting at all.
 */

export type FillStatus = 'FILLED' | 'SKIPPED' | 'ESCALATED' | 'FAILED' | 'NEEDS_GENERATION';

export interface FillOutcome {
  ref: string;
  label: string;
  status: FillStatus;
  valueSource: 'PROFILE' | 'GENERATED' | 'HUMAN' | 'DOCUMENT' | 'DEFAULT';
  /** Redacted when the source path is sensitive. */
  displayValue: string;
  profilePath?: string;
  documentKey?: string;
  reason?: string;
  verified: boolean;
}

export interface FillContext {
  page: Page;
  snapshot: PageSnapshot;
  profile: Profile;
  applicationId?: string;
  stepId?: string;
  /** Answers already generated for GENERATE refs, keyed by ref. */
  generated?: Map<string, string>;
  /** true = compute outcomes without touching the page. */
  dryRun?: boolean;
}

function locate(page: Page, field: Field): Locator {
  const scope = field.frame
    ? page.frameLocator(`iframe >> nth=${Number(field.frame.replace('if', '')) - 1}`)
    : page;
  const index = Number(field.ref.split('.').pop()!.replace('f', '')) - 1;
  const sel = 'input:not([type=hidden]), textarea, select, [contenteditable="true"]';
  // Refs are positional by construction in snapshot.ts, so nth() is the
  // reliable inverse. Hints give us a stronger selector when they exist.
  const byName = field.hints?.[0];
  if (byName) {
    const cand = scope.locator(`[name="${CSS_escape(byName)}"], #${CSS_escape(byName)}`).first();
    return cand;
  }
  return scope.locator(sel).nth(index);
}

/** CSS.escape is a browser API; this is the subset we need in Node. */
function CSS_escape(s: string): string {
  return s.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

function display(value: string, path: string | undefined): string {
  if (path && isSensitivePath(path)) return `«redacted:${value.length}»`;
  return value.length > 80 ? `${value.slice(0, 77)}…` : value;
}

/** Fuzzy-pick the closest option; returns null rather than a bad guess. */
function pickOption(options: string[], want: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const w = norm(want);
  if (!w) return null;
  const exact = options.find((o) => norm(o) === w);
  if (exact) return exact;
  const starts = options.filter((o) => norm(o).startsWith(w) || w.startsWith(norm(o)));
  if (starts.length === 1) return starts[0]!;
  const contains = options.filter((o) => norm(o).includes(w) || w.includes(norm(o)));
  return contains.length === 1 ? contains[0]! : null;
}

async function readBack(loc: Locator, field: Field): Promise<string> {
  try {
    if (field.kind === 'checkbox') return (await loc.isChecked()) ? 'true' : 'false';
    if (field.kind === 'file') {
      return await loc.evaluate((el) => (el as HTMLInputElement).files?.[0]?.name ?? '');
    }
    return (await loc.inputValue()).trim();
  } catch {
    return '';
  }
}

export async function applyFieldmap(mappings: Mapping[], ctx: FillContext): Promise<FillOutcome[]> {
  const byRef = new Map(ctx.snapshot.fields.map((f) => [f.ref, f]));
  const out: FillOutcome[] = [];

  for (const m of mappings) {
    const field = byRef.get(m.ref);
    if (!field) continue;

    const base = { ref: m.ref, label: field.label, verified: false } as const;

    if (m.action === 'SKIP') {
      out.push({ ...base, status: 'SKIPPED', valueSource: 'DEFAULT', displayValue: '',
        ...(m.reason ? { reason: m.reason } : {}) });
      continue;
    }
    if (m.action === 'ESCALATE') {
      out.push({ ...base, status: 'ESCALATED', valueSource: 'HUMAN', displayValue: '',
        reason: m.reason ?? 'human decision required' });
      continue;
    }
    if (m.action === 'GENERATE' && !ctx.generated?.has(m.ref)) {
      out.push({ ...base, status: 'NEEDS_GENERATION', valueSource: 'GENERATED', displayValue: '',
        ...(m.question ? { reason: m.question } : {}) });
      continue;
    }

    // ── Resolve the value deterministically ──────────────────────────
    let value: string | null = null;
    let source: FillOutcome['valueSource'] = 'PROFILE';
    let documentKey: string | undefined;

    if (m.action === 'UPLOAD') {
      const match = matchDocument(m.document_label ?? field.label);
      if (!match.best) {
        out.push({ ...base, status: 'ESCALATED', valueSource: 'DOCUMENT', displayValue: '',
          reason: match.blocked ?? 'no document matched' });
        continue;
      }
      value = match.best.entry.file;
      documentKey = match.best.entry.key;
      source = 'DOCUMENT';
    } else if (m.action === 'GENERATE') {
      value = ctx.generated!.get(m.ref)!;
      source = 'GENERATED';
    } else if (m.profile_path) {
      const r = resolve(m.profile_path, ctx.profile);
      if (!isKnown(r)) {
        out.push({ ...base, status: 'ESCALATED', valueSource: 'PROFILE', displayValue: '',
          profilePath: m.profile_path, reason: `profile has no value for ${m.profile_path}` });
        continue;
      }
      value = typeof r === 'boolean' ? (r ? 'Yes' : 'No') : String(r);
    } else if (m.value != null) {
      value = m.value;
      source = 'DEFAULT';
    }

    if (value === null) {
      out.push({ ...base, status: 'FAILED', valueSource: source, displayValue: '',
        reason: 'no value resolved' });
      continue;
    }

    const shown = display(value, m.profile_path ?? undefined);

    if (ctx.dryRun) {
      out.push({ ...base, status: 'FILLED', valueSource: source, displayValue: shown, verified: false,
        ...(m.profile_path ? { profilePath: m.profile_path } : {}),
        ...(documentKey ? { documentKey } : {}) });
      continue;
    }

    // ── Write it ─────────────────────────────────────────────────────
    const loc = locate(ctx.page, field);
    let failure: string | undefined;
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
      switch (field.kind) {
        case 'select': {
          const opt = pickOption(field.options ?? [], value);
          if (!opt) { failure = `no option matches "${shown}"`; break; }
          await loc.selectOption({ label: opt });
          value = opt;
          break;
        }
        case 'radio': {
          const opt = pickOption(field.options ?? [], value);
          if (!opt) { failure = `no radio option matches "${shown}"`; break; }
          await ctx.page.getByRole('radio', { name: opt, exact: false }).first().check({ timeout: 5000 });
          value = opt;
          break;
        }
        case 'checkbox':
          value === 'true' ? await loc.check({ timeout: 5000 }) : await loc.uncheck({ timeout: 5000 });
          break;
        case 'file': {
          const { loadManifest, absPath } = await import('../documents/index.js');
          const man = loadManifest();
          const entry = man.documents.find((d) => d.key === documentKey)!;
          await loc.setInputFiles(absPath(man, entry));
          break;
        }
        default:
          await loc.fill('');
          await loc.fill(value);
      }
      await jitter(120);
    } catch (e) {
      failure = e instanceof Error ? e.message.split('\n')[0] : String(e);
    }

    if (failure) {
      out.push({ ...base, status: 'FAILED', valueSource: source, displayValue: shown, reason: failure,
        ...(m.profile_path ? { profilePath: m.profile_path } : {}) });
      continue;
    }

    // ── Read back. A write we cannot confirm is not a write. ─────────
    const actual = await readBack(loc, field);
    const verified = field.kind === 'file'
      ? actual.length > 0
      : field.kind === 'checkbox' || field.kind === 'radio'
        ? actual === value || actual === 'true'
        : actual.replace(/\s+/g, '') === value.replace(/\s+/g, '');

    const outcome: FillOutcome = {
      ...base, status: verified ? 'FILLED' : 'FAILED', valueSource: source,
      displayValue: shown, verified,
      ...(m.profile_path ? { profilePath: m.profile_path } : {}),
      ...(documentKey ? { documentKey } : {}),
      ...(verified ? {} : { reason: `read-back mismatch: field holds "${display(actual, m.profile_path ?? undefined)}"` }),
    };
    out.push(outcome);
  }

  if (ctx.applicationId && !ctx.dryRun) persist(out, ctx);
  return out;
}

function persist(outcomes: FillOutcome[], ctx: FillContext): void {
  const db = getDb();
  const byRef = new Map(ctx.snapshot.fields.map((f) => [f.ref, f]));
  const stmt = db.prepare(`
    INSERT INTO field_fills (id, application_id, step_id, field_ref, label_text, field_kind,
      value_written, value_source, profile_ref, document_key, verified_readback)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const run = db.transaction(() => {
    for (const o of outcomes) {
      if (o.status !== 'FILLED' && o.status !== 'FAILED') continue;
      stmt.run(randomUUID(), ctx.applicationId!, ctx.stepId ?? null, o.ref, o.label,
        byRef.get(o.ref)?.kind ?? null, o.displayValue, o.valueSource,
        o.profilePath ?? null, o.documentKey ?? null, o.verified ? 1 : 0);
    }
  });
  run();
}

export function summarise(outcomes: FillOutcome[]): Record<FillStatus, number> {
  const s: Record<FillStatus, number> = {
    FILLED: 0, SKIPPED: 0, ESCALATED: 0, FAILED: 0, NEEDS_GENERATION: 0,
  };
  for (const o of outcomes) s[o.status]++;
  logger.info(s, 'fill summary');
  return s;
}
