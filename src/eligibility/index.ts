import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../core/db.js';
import { logger } from '../core/logger.js';
import { askJson } from '../ai/client.js';
import { resolve, isKnown, type Profile } from '../profile/index.js';

/**
 * Hybrid by design: Claude EXTRACTS criteria from prose, code COMPARES them.
 *
 * Asking a model "am I eligible?" makes the answer a matter of persuasion.
 * Asking it only "what does this advert require?" and then checking each
 * requirement against stored facts in TypeScript makes the answer auditable,
 * reproducible, and free on the second run.
 */

export const CRITERION_KINDS = [
  'CITIZENSHIP', 'FIELD_OF_STUDY', 'QUALIFICATION_LEVEL', 'YEAR_OF_STUDY',
  'ACADEMIC_AVERAGE', 'INSTITUTION', 'AGE', 'DRIVERS_LICENCE', 'LOCATION',
  'EXPERIENCE_YEARS', 'FUNDING_STATUS', 'HOUSEHOLD_INCOME', 'GRADUATION_YEAR',
  'LANGUAGE', 'SKILL', 'OTHER',
] as const;

export const CriterionSchema = z.object({
  kind: z.enum(CRITERION_KINDS),
  /** The requirement in the advert's own words, for the explanation. */
  text: z.string(),
  op: z.enum(['equals', 'in', 'at_least', 'at_most', 'has', 'between']),
  value: z.union([z.string(), z.number(), z.array(z.string()), z.array(z.number())]),
  mandatory: z.boolean(),
});

export const ExtractionSchema = z.object({
  organisation: z.string().nullish(),
  title: z.string().nullish(),
  type: z.enum(['BURSARY', 'INTERNSHIP', 'GRADUATE', 'LEARNERSHIP', 'JOB', 'VACWORK', 'UNKNOWN']),
  closing_date: z.string().nullish(),
  criteria: z.array(CriterionSchema),
});

export type Criterion = z.infer<typeof CriterionSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;

export type CriterionVerdict = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_CHECKABLE';

export interface CheckedCriterion {
  criterion: Criterion;
  verdict: CriterionVerdict;
  evidence: string;
  profileRef?: string;
}

export interface Assessment {
  verdict: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'UNCERTAIN';
  checked: CheckedCriterion[];
  openQuestions: string[];
  costUsd: number;
}

/** Which profile path answers which kind of requirement. */
const PATH_FOR: Partial<Record<Criterion['kind'], string[]>> = {
  CITIZENSHIP: ['personal.citizenship.status', 'personal.citizenship.country', 'personal.nationality'],
  FIELD_OF_STUDY: ['education.current.qualification'],
  QUALIFICATION_LEVEL: ['education.current.nqf_level'],
  YEAR_OF_STUDY: ['education.current.year_of_study'],
  ACADEMIC_AVERAGE: ['education.current.final_year_average', 'education.current.cumulative_average'],
  INSTITUTION: ['education.current.institution'],
  DRIVERS_LICENCE: ['personal.drivers_licence.has'],
  LOCATION: ['personal.address.term.province', 'personal.address.home.province'],
  FUNDING_STATUS: ['funding.nsfas.funded'],
  HOUSEHOLD_INCOME: ['funding.household.combined_income_zar_pa'],
  GRADUATION_YEAR: ['education.current.expected_completion'],
  AGE: ['personal.date_of_birth'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Adverts name fields of study inconsistently: a qualification called
 * "Diploma in Business Information Technology" has to satisfy requirements
 * written as "IT", "ICT", "Computer Science" or even the occupation
 * "IT Professionals". Without this, the engine reads a genuine match as a
 * mismatch and discards the opportunity.
 *
 * These are domain synonyms, not claims about the applicant - the profile
 * still has to actually contain one of the terms.
 */
const FIELD_SYNONYMS: string[][] = [
  ['information technology', 'it', 'ict', 'it professional', 'it professionals',
   'information systems', 'informatics', 'information and communication technology',
   'computer science', 'computing', 'computer studies', 'software', 'software engineering',
   'software development', 'software developer', 'data science', 'data scientist',
   'business information technology', 'information technology professional'],
  ['business analysis', 'business analyst', 'systems analysis', 'systems analyst',
   'business systems'],
  ['commerce', 'bcom', 'business', 'business management', 'business studies'],
  ['engineering', 'engineer', 'engineers'],
  ['accounting', 'accountant', 'accountants', 'accounting science'],
];

/** Every synonym-group term implied by a phrase. */
function expandField(text: string): Set<string> {
  const t = norm(text);
  const out = new Set<string>([t]);
  for (const group of FIELD_SYNONYMS) {
    if (group.some((term) => t === term || t.includes(term) || term.includes(t))) {
      for (const term of group) out.add(term);
    }
  }
  return out;
}

function fieldsOverlap(have: string, want: string): boolean {
  const a = expandField(have);
  const b = expandField(want);
  for (const x of a) for (const y of b) if (x === y) return true;
  return false;
}

function compare(c: Criterion, raw: string | number | boolean): CriterionVerdict {
  const want = c.value;

  if (typeof raw === 'boolean' || c.op === 'has') {
    const b = typeof raw === 'boolean' ? raw : /^(yes|true)$/i.test(String(raw));
    const target = typeof want === 'boolean' ? want : !/^(no|false)$/i.test(String(want));
    return b === target ? 'PASS' : 'FAIL';
  }

  if (c.op === 'at_least' || c.op === 'at_most' || c.op === 'between') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^\d.]/g, ''));
    if (Number.isNaN(n)) return 'UNKNOWN';
    if (c.op === 'between' && Array.isArray(want) && want.length === 2) {
      const [lo, hi] = want.map(Number);
      return n >= lo! && n <= hi! ? 'PASS' : 'FAIL';
    }
    const t = Number(Array.isArray(want) ? want[0] : want);
    if (Number.isNaN(t)) return 'UNKNOWN';
    return c.op === 'at_least' ? (n >= t ? 'PASS' : 'FAIL') : (n <= t ? 'PASS' : 'FAIL');
  }

  const have = norm(String(raw));
  const rawList = Array.isArray(want) ? want.map(String) : [String(want)];
  const list = rawList.map(norm);

  // Substring both ways: "Diploma in Business Information Technology" should
  // satisfy a requirement of "Information Technology".
  if (list.some((w) => w === have || have.includes(w) || w.includes(have))) return 'PASS';

  // Field-of-study naming is inconsistent enough to need synonym expansion.
  if (c.kind === 'FIELD_OF_STUDY' && rawList.some((w) => fieldsOverlap(String(raw), w))) {
    return 'PASS';
  }

  /**
   * A non-match is only a FAIL when we can positively establish the
   * requirement is unmet. That needs a CLOSED set of acceptable values:
   *
   *   op "in" with a list      → the advert enumerated what it accepts, so
   *                              being outside the list really is a fail.
   *   a closed-vocabulary kind → citizenship, province, institution, language
   *                              have finite value sets we can reason over.
   *
   * Everything else - "Occupation of High Demand", "demonstrate financial
   * need", "enrolled at an accredited university" - is a label or a judgement,
   * not a checkable value. Calling those FAIL silently discards opportunities
   * the person qualifies for, which is the most expensive mistake this engine
   * can make. They become UNKNOWN and get asked about instead.
   */
  // INSTITUTION is deliberately NOT here: an abbreviation and a full university
  // name are the same place, and a name mismatch proves nothing.
  const CLOSED_VOCAB_KINDS = new Set(['CITIZENSHIP', 'LOCATION', 'LANGUAGE']);
  const enumerated = c.op === 'in' && rawList.length > 0
    && rawList.every((v) => v.trim().split(/\s+/).length <= 5);

  if (enumerated || CLOSED_VOCAB_KINDS.has(c.kind)) return 'FAIL';
  return 'UNKNOWN';
}

export function check(extraction: Extraction, profile: Profile): Omit<Assessment, 'costUsd'> {
  const checked: CheckedCriterion[] = [];

  for (const c of extraction.criteria) {
    const paths = PATH_FOR[c.kind] ?? [];
    if (!paths.length) {
      checked.push({ criterion: c, verdict: 'NOT_CHECKABLE', evidence: 'no profile field covers this' });
      continue;
    }

    let done = false;
    for (const p of paths) {
      const v = resolve(p, profile);
      if (!isKnown(v)) continue;
      const verdict = compare(c, v);
      // A later path may still pass (final_year_average vs cumulative).
      if (verdict === 'FAIL' && paths.indexOf(p) < paths.length - 1) continue;
      checked.push({
        criterion: c, verdict, profileRef: p,
        evidence: `${p} = ${String(v)}`,
      });
      done = true;
      break;
    }
    if (!done) {
      checked.push({
        criterion: c, verdict: 'UNKNOWN', profileRef: paths[0]!,
        evidence: `${paths[0]} is not set in your profile`,
      });
    }
  }

  const mandatory = checked.filter((c) => c.criterion.mandatory);
  const openQuestions = checked
    .filter((c) => c.verdict === 'UNKNOWN' || c.verdict === 'NOT_CHECKABLE')
    .map((c) => c.criterion.text);

  const verdict: Assessment['verdict'] =
    mandatory.some((c) => c.verdict === 'FAIL') ? 'NOT_ELIGIBLE'
      : mandatory.some((c) => c.verdict === 'UNKNOWN' || c.verdict === 'NOT_CHECKABLE') ? 'UNCERTAIN'
        : 'ELIGIBLE';

  return { verdict, checked, openQuestions };
}

function buildPrompt(description: string): string {
  return `Extract the ELIGIBILITY REQUIREMENTS from this South African opportunity advert.
Do not judge anyone's eligibility. Only list what the advert requires.

ADVERT:
${description.slice(0, 12_000)}

Return JSON:
{ "organisation", "title", "type", "closing_date",
  "criteria": [ { "kind", "text", "op", "value", "mandatory" } ] }

kind: ${CRITERION_KINDS.join(' | ')}
op:   equals | in | at_least | at_most | has | between
type: BURSARY | INTERNSHIP | GRADUATE | LEARNERSHIP | JOB | VACWORK | UNKNOWN

RULES:
- "value" must be CHECKABLE: a number, a boolean, or a short enumerable term
  such as "CITIZEN", "Gauteng", or a list like ["Information Technology",
  "Computer Science"]. Never a sentence.
- If a requirement cannot be reduced to a checkable value - "demonstrate
  financial need", "commitment to your studies", "must be enrolled at an
  accredited university" - use kind "OTHER". Do not invent a comparison for it.
- "text" is the requirement quoted or closely paraphrased from the advert.
- mandatory=true only when the advert states it as a requirement. Words like
  "advantageous", "preferred", "beneficial", "a plus" mean mandatory=false.
- Numeric requirements use at_least / at_most with a NUMBER value
  (e.g. an average of 65% -> {"kind":"ACADEMIC_AVERAGE","op":"at_least","value":65}).
- Lists of acceptable fields of study use op "in" with an array.
- closing_date as YYYY-MM-DD, or null if not stated. Never invent one.
- If the advert states no requirements, return an empty criteria array.

Output JSON only.`;
}

export async function assess(
  description: string,
  profile: Profile,
  opts: { opportunityId?: string; runId?: string } = {},
): Promise<Assessment & { extraction: Extraction }> {
  const res = await askJson(buildPrompt(description), ExtractionSchema, {
    purpose: 'eligibility.extract',
    ...(opts.runId ? { runId: opts.runId } : {}),
  });

  const result = check(res.value, profile);
  const assessment: Assessment & { extraction: Extraction } = {
    ...result, costUsd: res.usage.costUsd, extraction: res.value,
  };

  if (opts.opportunityId) {
    getDb().prepare(`
      INSERT INTO eligibility_assessments
        (id, opportunity_id, verdict, criteria_json, open_questions_json, model, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), opts.opportunityId, result.verdict,
      JSON.stringify(result.checked), JSON.stringify(result.openQuestions),
      'cheap', res.usage.costUsd);
  }

  logger.info({ verdict: result.verdict, criteria: result.checked.length, cost: res.usage.costUsd },
    'eligibility assessed');
  return assessment;
}

const MARK: Record<CriterionVerdict, string> = {
  PASS: '✓', FAIL: '✗', UNKNOWN: '?', NOT_CHECKABLE: '·',
};

export function explain(a: Assessment, title = 'Opportunity'): string {
  const lines = [`${a.verdict} — ${title}`, ''];
  const order: CriterionVerdict[] = ['FAIL', 'UNKNOWN', 'NOT_CHECKABLE', 'PASS'];
  for (const v of order) {
    for (const c of a.checked.filter((x) => x.verdict === v)) {
      const req = c.criterion.mandatory ? '' : ' (advantageous)';
      lines.push(`  ${MARK[v]} ${c.criterion.text.slice(0, 52).padEnd(54)}${c.evidence}${req}`);
    }
  }
  if (a.openQuestions.length) {
    lines.push('', `  ${a.openQuestions.length} question(s) for you before this can proceed.`);
  }
  return lines.join('\n');
}
