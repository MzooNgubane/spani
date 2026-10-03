import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../core/db.js';
import { logger } from '../core/logger.js';
import { askJson, type AiUsage } from '../ai/client.js';
import { snapshotForPrompt, type PageSnapshot } from '../browser/snapshot.js';
import { promptablePaths, resolve, isKnown, type Profile, type DeclarationCategory } from '../profile/index.js';

/**
 * Turning a page snapshot into a plan of what to put where.
 *
 * THE CONTRACT WITH CLAUDE: it may return exactly three kinds of thing -
 * a profile PATH, a request to WRITE prose from cited facts, or an ESCALATION.
 * It may never return a personal value to type into a form. That is what
 * structurally prevents a hallucinated ID number, employer or grade from
 * reaching a real application.
 *
 * The only literal values it may emit are a SELECT option (which must match
 * one of the options we showed it) and a CHECK boolean - both validated here.
 */

export const ACTIONS = ['FILL', 'SELECT', 'CHECK', 'UPLOAD', 'GENERATE', 'SKIP', 'ESCALATE'] as const;

export const MappingSchema = z.object({
  ref: z.string(),
  action: z.enum(ACTIONS),
  /** FILL / SELECT: the dot-path whose value belongs in this field. */
  profile_path: z.string().nullish(),
  /** SELECT: exact option text. CHECK: "true" | "false". Nothing else. */
  value: z.string().nullish(),
  /** UPLOAD: the document TYPE requested, in the site's own words. */
  document_label: z.string().nullish(),
  /** GENERATE: the question being asked, normalised. */
  question: z.string().nullish(),
  max_words: z.number().int().positive().nullish(),
  /** ESCALATE / SKIP: why. Shown to the user verbatim. */
  reason: z.string().nullish(),
  confidence: z.number().min(0).max(1).default(0.5),
});

export const FieldmapSchema = z.array(MappingSchema);
export type Mapping = z.infer<typeof MappingSchema>;

export interface FieldmapResult {
  mappings: Mapping[];
  cacheHit: boolean;
  usage: AiUsage | null;
  rejected: Array<{ ref: string; why: string }>;
}

/**
 * Declaration-shaped questions, and which standing-authorisation category each
 * belongs to. A label matching one of these is never answered on the model's
 * say-so; it is answered only if the user has pre-approved that category AND
 * the profile actually holds the fact. Otherwise it escalates.
 *
 * Order matters: the most specific patterns come first, because "I confirm I
 * have no criminal record" matches both the criminal pattern and the generic
 * "I confirm" one, and it must be classified as the former.
 */
const DECLARATION_PATTERNS: Array<{ re: RegExp; category: DeclarationCategory | null }> = [
  { re: /criminal|conviction|offence|felony/i, category: 'criminal_record' },
  { re: /disab(led|ility)/i, category: 'disability_status' },
  { re: /\b(race|ethnic|population group)\b/i, category: 'race_declaration' },
  { re: /\bcitizen(ship)?\b/i, category: 'citizenship_declaration' },
  { re: /popia|protection of personal information|consent to the processing|process(ing)? of my personal/i,
    category: 'popia_consent' },
  { re: /terms and conditions|privacy policy|indemnity|waiver/i, category: 'terms_and_conditions' },
  { re: /(declare|certify|confirm).{0,40}(true|correct|accurate|complete)/i,
    category: 'information_true_and_correct' },
  // Anything else declaration-shaped has no category, so it always escalates.
  { re: /salary|remuneration|expected (pay|ctc)/i, category: null },
  { re: /medical|health condition|chronic/i, category: null },
  { re: /political|union membership/i, category: null },
  { re: /i (hereby )?(declare|certify|confirm|agree|consent|accept|indemnify)/i, category: null },
];

/** The profile field that must be known before a category may be auto-answered. */
const CATEGORY_REQUIRES: Partial<Record<DeclarationCategory, string>> = {
  criminal_record: 'personal.criminal_record',
  disability_status: 'personal.disability.has',
  race_declaration: 'personal.race',
  citizenship_declaration: 'personal.citizenship.status',
};

function classifyDeclaration(label: string): { isDeclaration: boolean; category: DeclarationCategory | null } {
  for (const p of DECLARATION_PATTERNS) {
    if (p.re.test(label)) return { isDeclaration: true, category: p.category };
  }
  return { isDeclaration: false, category: null };
}

/** May this declaration be answered without asking? */
function declarationAllowed(
  category: DeclarationCategory | null,
  profile: Profile,
): { allowed: boolean; why: string } {
  if (!category) return { allowed: false, why: 'no standing authorisation covers this declaration' };
  if (!profile.policy.pre_approved_declarations.includes(category)) {
    return { allowed: false, why: `"${category}" is not in your standing authorisation` };
  }
  const required = CATEGORY_REQUIRES[category];
  if (required && !isKnown(resolve(required, profile))) {
    return { allowed: false, why: `authorised, but ${required} is not set in your profile` };
  }
  return { allowed: true, why: `pre-approved: ${category}` };
}

function buildPrompt(snap: PageSnapshot, profile: Profile): string {
  // Paths only, never values. Marked known/unknown so the model does not
  // propose a path the profile cannot actually answer.
  const paths = promptablePaths(profile)
    .filter((p) => !/\.modules\.\d+\./.test(p.path))
    .map((p) => `${p.path}${p.known ? '' : ' [UNKNOWN]'}${p.sensitive ? ' [SENSITIVE]' : ''}`)
    .join('\n');

  const approved = profile.policy.pre_approved_declarations;
  const declarationRule = approved.length
    ? `3. The person has given STANDING AUTHORISATION for these declaration types,
   so answer them from the profile like any other field - do NOT escalate them:
${approved.map((c) => `     - ${c}`).join('\n')}
   Every OTHER declaration, and anything about salary, medical history or
   political affiliation, must still ESCALATE.`
    : `3. Any legal declaration, criminal record, disability, race, salary, medical or
   consent question: ESCALATE. Never CHECK or SELECT it.`;

  return `You map form fields to a person's stored profile. Output JSON only.

PAGE:
${snapshotForPrompt(snap)}

AVAILABLE PROFILE PATHS (values are NOT shown to you and you must not invent them):
${paths}

Return a JSON array. One object per field ref in the page above. Each object:
  { "ref", "action", "profile_path"?, "value"?, "document_label"?,
    "question"?, "max_words"?, "reason"?, "confidence" }

ACTIONS:
  FILL      text-like field answered from the profile. Give "profile_path".
  SELECT    dropdown/radio. Give "profile_path" when the profile decides it,
            otherwise "value" copied EXACTLY from that field's options list.
  CHECK     checkbox. "value" is "true" or "false".
  UPLOAD    file input. "document_label" = what the site is asking for, in the
            site's own words.
  GENERATE  free text that must be written (motivation, "why us", goals).
            Give "question" and "max_words".
  SKIP      field that should be left alone. Give "reason".
  ESCALATE  a human must decide. Give "reason".

HARD RULES:
1. NEVER put a personal value in "value". No names, numbers, dates, addresses,
   institutions, grades. Those come from "profile_path" only.
2. A path marked [UNKNOWN] has no stored answer. If a required field needs it,
   use ESCALATE, not a guess.
${declarationRule}
4. "value" for SELECT must be copied character-for-character from that field's
   own options array.
4b. A Yes/No question backed by a true/false profile field is an ordinary FILL
   or SELECT. Give the profile_path and nothing else - the code converts the
   boolean to the field's own wording. Do not escalate over the format.
5. If you are unsure which path fits, ESCALATE with a short reason. An escalation
   costs 20 seconds of the person's time. A wrong answer costs them the application.
6. Every ref in the page must appear exactly once in your array.

Output the JSON array and nothing else.`;
}

/**
 * Validate what came back. Anything that breaks the contract is rewritten to
 * ESCALATE rather than dropped, so the field still gets an answer - from a
 * human instead of from a guess.
 */
function enforce(
  mappings: Mapping[],
  snap: PageSnapshot,
  profile: Profile,
): { clean: Mapping[]; rejected: Array<{ ref: string; why: string }> } {
  const byRef = new Map(snap.fields.map((f) => [f.ref, f]));
  const known = new Set(promptablePaths(profile).map((p) => p.path));
  const rejected: Array<{ ref: string; why: string }> = [];
  const seen = new Set<string>();
  const clean: Mapping[] = [];

  const escalate = (ref: string, why: string, m?: Mapping): Mapping => {
    rejected.push({ ref, why });
    return { ...(m ?? { ref, confidence: 0 }), ref, action: 'ESCALATE', reason: why, confidence: 0 };
  };

  for (const m of mappings) {
    const field = byRef.get(m.ref);
    if (!field) { rejected.push({ ref: m.ref, why: 'no such field on the page' }); continue; }
    if (seen.has(m.ref)) { rejected.push({ ref: m.ref, why: 'duplicate mapping' }); continue; }
    seen.add(m.ref);

    // Rule 3 is enforced here, not trusted to the model.
    if (m.action !== 'ESCALATE' && m.action !== 'SKIP') {
      const { isDeclaration, category } = classifyDeclaration(field.label);
      if (isDeclaration) {
        const verdict = declarationAllowed(category, profile);
        if (!verdict.allowed) {
          clean.push(escalate(m.ref, `${verdict.why}: "${field.label}"`, m));
          continue;
        }
        logger.info({ ref: m.ref, category, label: field.label.slice(0, 60) },
          'declaration answered under standing authorisation');
      }
    }

    switch (m.action) {
      case 'FILL':
      case 'SELECT': {
        if (m.profile_path) {
          if (!known.has(m.profile_path)) {
            clean.push(escalate(m.ref, `unknown profile path "${m.profile_path}"`, m)); continue;
          }
          if (!isKnown(resolve(m.profile_path, profile))) {
            clean.push(escalate(m.ref, `profile has no value for ${m.profile_path}`, m)); continue;
          }
        } else if (m.action === 'SELECT' && m.value) {
          if (!field.options?.includes(m.value)) {
            clean.push(escalate(m.ref, `"${m.value}" is not one of this field's options`, m)); continue;
          }
        } else {
          clean.push(escalate(m.ref, 'no profile_path and no valid option given', m)); continue;
        }
        // Rule 1: a literal value on a text field is a fabrication risk.
        if (m.action === 'FILL' && m.value && !m.profile_path) {
          clean.push(escalate(m.ref, 'model supplied a literal value for a text field', m)); continue;
        }
        break;
      }
      case 'CHECK': {
        // A checkbox may be answered from a boolean profile field as well as
        // from a literal. Requiring the literal made the model escalate
        // questions it had correctly mapped to a stored true/false.
        if (m.profile_path) {
          if (!known.has(m.profile_path)) {
            clean.push(escalate(m.ref, `unknown profile path "${m.profile_path}"`, m)); continue;
          }
          const v = resolve(m.profile_path, profile);
          if (!isKnown(v)) {
            clean.push(escalate(m.ref, `profile has no value for ${m.profile_path}`, m)); continue;
          }
          m.value = v === true || /^(yes|true)$/i.test(String(v)) ? 'true' : 'false';
        } else if (m.value !== 'true' && m.value !== 'false') {
          clean.push(escalate(m.ref, 'CHECK needs a profile_path or value "true"/"false"', m)); continue;
        }
        break;
      }
      case 'UPLOAD': {
        if (field.kind !== 'file') { clean.push(escalate(m.ref, 'UPLOAD on a non-file field', m)); continue; }
        if (!m.document_label) {
          // The visible label is a fine fallback; the matcher handles wording.
          m.document_label = field.label;
        }
        break;
      }
      case 'GENERATE': {
        if (!m.question) { clean.push(escalate(m.ref, 'GENERATE without a question', m)); continue; }
        if (!m.max_words) m.max_words = field.maxLength ? Math.floor(field.maxLength / 7) : 200;
        break;
      }
      case 'SKIP':
      case 'ESCALATE':
        break;
    }
    clean.push(m);
  }

  // Rule 6: a required field the model forgot must not silently stay empty.
  for (const f of snap.fields) {
    if (seen.has(f.ref)) continue;
    if (f.required) clean.push(escalate(f.ref, `required field "${f.label}" was not mapped`));
    else clean.push({ ref: f.ref, action: 'SKIP', reason: 'not mapped, not required', confidence: 0 });
  }

  return { clean, rejected };
}

function readCache(siteKey: string, signature: string): Mapping[] | null {
  const row = getDb().prepare(
    'SELECT mapping_json FROM site_fieldmaps WHERE site_key = ? AND page_signature = ?',
  ).get(siteKey, signature) as { mapping_json: string } | undefined;
  if (!row) return null;
  const parsed = FieldmapSchema.safeParse(JSON.parse(row.mapping_json));
  return parsed.success ? parsed.data : null;
}

export function recordFieldmapOutcome(siteKey: string, signature: string, ok: boolean): void {
  getDb().prepare(
    ok
      ? `UPDATE site_fieldmaps SET times_used = times_used + 1, last_success_at = datetime('now')
         WHERE site_key = ? AND page_signature = ?`
      : `UPDATE site_fieldmaps SET times_failed = times_failed + 1, last_failure_at = datetime('now')
         WHERE site_key = ? AND page_signature = ?`,
  ).run(siteKey, signature);
}

/** Drop a cached map after a failure, so the next run re-asks once. */
export function invalidateFieldmap(siteKey: string, signature: string): void {
  getDb().prepare('DELETE FROM site_fieldmaps WHERE site_key = ? AND page_signature = ?')
    .run(siteKey, signature);
  logger.warn({ siteKey, signature }, 'fieldmap invalidated');
}

export interface MapOptions {
  siteKey: string;
  profile: Profile;
  runId?: string;
  applicationId?: string;
  /** Skip the cache, e.g. after a failure. */
  fresh?: boolean;
}

export async function mapFields(snap: PageSnapshot, opts: MapOptions): Promise<FieldmapResult> {
  if (!opts.fresh) {
    const cached = readCache(opts.siteKey, snap.signature);
    if (cached) {
      // Re-run enforcement: the profile may have changed since we cached.
      const { clean, rejected } = enforce(cached, snap, opts.profile);
      logger.info({ siteKey: opts.siteKey, signature: snap.signature, fields: snap.fields.length },
        'fieldmap cache hit - no AI call');
      return { mappings: clean, cacheHit: true, usage: null, rejected };
    }
  }

  const res = await askJson(buildPrompt(snap, opts.profile), FieldmapSchema, {
    purpose: 'fieldmap',
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.applicationId ? { applicationId: opts.applicationId } : {}),
  });

  const { clean, rejected } = enforce(res.value, snap, opts.profile);

  // Only cache a map that did not need rescuing; a rescued one would bake in
  // the model's mistakes and we would never re-ask.
  if (!rejected.length) {
    getDb().prepare(`
      INSERT INTO site_fieldmaps (id, site_key, page_signature, mapping_json, confidence)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(site_key, page_signature) DO UPDATE SET mapping_json = excluded.mapping_json
    `).run(randomUUID(), opts.siteKey, snap.signature, JSON.stringify(clean),
      clean.reduce((a, m) => a + m.confidence, 0) / Math.max(1, clean.length));
  }

  logger.info({
    siteKey: opts.siteKey, fields: snap.fields.length, rejected: rejected.length,
    cost: res.usage.costUsd, cached: false,
  }, 'fieldmap built');

  return { mappings: clean, cacheHit: false, usage: res.usage, rejected };
}

/** Exposed so the declaration rules can be tested without a browser or an AI call. */
export const enforceForTest = enforce;
