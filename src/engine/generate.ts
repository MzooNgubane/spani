import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../core/db.js';
import { logger } from '../core/logger.js';
import { askJson } from '../ai/client.js';
import { resolve, isKnown, promptablePaths, isSensitivePath, type Profile } from '../profile/index.js';

/**
 * Writing the free-text answers - the only place the agent produces prose that
 * goes out under the person's name.
 *
 * Tailoring means SELECTING and REPHRASING real facts. It never means adding
 * one. The model is given a small set of facts it may use, must cite a profile
 * path for each factual claim, and the result is then checked against those
 * facts before it is allowed anywhere near a form.
 */

export const GenerationSchema = z.object({
  answer: z.string(),
  /** Every factual claim must name the profile path it came from. */
  source_refs: z.array(z.string()),
  /** Anything the model wanted to say but could not support. */
  omitted: z.array(z.string()).default([]),
});

export type Generation = z.infer<typeof GenerationSchema>;

export interface GenerateOptions {
  question: string;
  maxWords: number;
  organisation?: string;
  opportunityTitle?: string;
  opportunityContext?: string;
  profile: Profile;
  runId?: string;
  applicationId?: string;
}

export interface GenerationResult {
  id: string;
  answer: string;
  sourceRefs: string[];
  validatorPassed: boolean;
  validatorNotes: string[];
  costUsd: number;
  reused: boolean;
}

function questionHash(q: string): string {
  return createHash('sha256').update(q.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim())
    .digest('hex').slice(0, 24);
}

/**
 * The fact sheet. Sensitive values are withheld even here - a motivation
 * letter never needs an ID number, and if it did, that would be a human task.
 */
function factSheet(profile: Profile): Array<{ path: string; value: string }> {
  const interesting = (p: string) =>
    /^(education|skills|projects|achievements|experience|preferences)\./.test(p) ||
    /^personal\.(first_name|surname|nationality|citizenship|address\.home\.(province|rural))/.test(p);

  return promptablePaths(profile)
    .filter((p) => p.known && !p.sensitive && interesting(p.path))
    .map((p) => ({ path: p.path, value: String(resolve(p.path, profile)) }))
    .filter((f) => f.value.length < 400);
}

function buildPrompt(o: GenerateOptions, facts: Array<{ path: string; value: string }>): string {
  return `Write one application answer for a South African student.

QUESTION: ${o.question}
LIMIT: ${o.maxWords} words maximum.
${o.organisation ? `ORGANISATION: ${o.organisation}` : ''}
${o.opportunityTitle ? `OPPORTUNITY: ${o.opportunityTitle}` : ''}
${o.opportunityContext ? `ABOUT THE OPPORTUNITY:\n${o.opportunityContext.slice(0, 2500)}` : ''}

THE ONLY FACTS YOU MAY USE ABOUT THIS PERSON:
${facts.map((f) => `${f.path} = ${f.value}`).join('\n')}

Return JSON: { "answer", "source_refs", "omitted" }

ABSOLUTE RULES:
1. Every factual claim in "answer" must come from the list above. Do not add a
   qualification, employer, job title, grade, certification, skill, award,
   responsibility, date or number that is not there.
2. "source_refs" lists the profile paths your answer actually relies on.
3. If the question needs a fact you were not given, leave it out and note it in
   "omitted". Do not approximate, round up, or infer it.
4. Do not describe anything as "extensive", "years of", "professional" or
   "industry" experience unless the facts say so. This person is a student.
5. First person, plain South African English, no invented anecdotes, no
   flattery of the organisation beyond what the opportunity text supports.
6. Stay under the word limit.

Output JSON only.`;
}

/**
 * The teeth behind rule 1.
 *
 * Flags numbers, years, percentages and capitalised entity names in the answer
 * that do not appear in the cited facts. It is deliberately noisy on the side
 * of caution: a false flag costs a regeneration, a miss costs a false claim on
 * a real application.
 */
export function validate(
  answer: string,
  sourceRefs: string[],
  profile: Profile,
  /**
   * Text the answer is legitimately allowed to draw on besides the profile -
   * the organisation name, the role title, the advert itself. Without this
   * every "why do you want to join X" answer fails, because X is by
   * definition not a fact about the applicant.
   */
  context = '',
): { passed: boolean; notes: string[] } {
  const notes: string[] = [];
  const allowedContext = context.toLowerCase();

  const citedValues = sourceRefs
    .map((p) => (isKnown(resolve(p, profile)) ? String(resolve(p, profile)) : ''))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const allValues = promptablePaths(profile)
    .filter((p) => p.known)
    .map((p) => String(resolve(p.path, profile)))
    .join(' ')
    .toLowerCase();

  // A citation is valid if it resolves to a value OR names a container that
  // holds values ("skills", "projects.0.technologies"). Requiring a leaf here
  // rejected perfectly good citations and burned a regeneration every time.
  const allPaths = promptablePaths(profile).map((p) => p.path);
  for (const raw of sourceRefs) {
    // Models annotate citations for readability - "skills.0 (SQL)". Strip that
    // before matching, or every annotated citation reads as a fabricated path
    // and a perfectly good answer is rejected.
    const ref = raw.replace(/\s*\(.*$/, '').trim();
    if (!ref) continue;
    if (isKnown(resolve(ref, profile))) continue;
    if (allPaths.some((p) => p === ref || p.startsWith(`${ref}.`))) continue;
    notes.push(`cites "${ref}", which the profile does not have`);
  }

  // Numbers: percentages, years, counts. The most common fabrication.
  const numbers = answer.match(/\b\d[\d.,]*%?\b/g) ?? [];
  for (const n of new Set(numbers)) {
    const bare = n.replace(/[%,]/g, '');
    if (citedValues.includes(bare) || allValues.includes(bare)) continue;
    if (allowedContext.includes(bare)) continue;
    if (/^(1|2|3|4|5|one|two)$/i.test(bare)) continue;   // ordinary prose counts
    notes.push(`number "${n}" does not appear in your profile`);
  }

  // Proper nouns: invented employers, institutions, technologies.
  const STOPWORDS = new Set([
    'i', 'my', 'the', 'this', 'a', 'an', 'south', 'african', 'africa', 'it',
    'university', 'diploma', 'bursary', 'programme', 'program', 'internship',
    'graduate', 'i am', 'as', 'in', 'at', 'of', 'and', 'to', 'for', 'with',
    'during', 'while', 'after', 'before', 'being', 'having', 'currently',
  ]);
  const entities = answer.match(/\b[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,})*/g) ?? [];
  for (const e of new Set(entities)) {
    // "The IDC" is the organisation the advert named, just with an article.
    const low = e.toLowerCase().replace(/^the\s+/, '');
    if (STOPWORDS.has(low)) continue;
    if (low.split(' ').every((w) => STOPWORDS.has(w))) continue;
    if (allValues.includes(low)) continue;
    if (allowedContext.includes(low)) continue;
    // Sentence-initial ordinary words are not entities.
    if (!/\s/.test(e) && new RegExp(`(^|[.!?]\\s+)${e}\\b`).test(answer)) continue;
    notes.push(`"${e}" is not in your profile`);
  }

  // Rule 4, checked rather than trusted.
  //
  // Employment history is the highest-stakes fabrication: a claimed tenure at
  // a named company is checkable by the employer and ends the application.
  // Naming the organisation is fine (context allows it); claiming to have
  // WORKED there is not, unless the profile says so.
  const hasExperience = (profile.experience?.length ?? 0) > 0;
  const OVERCLAIM: RegExp[] = [
    /\byears of (professional |industry |work )?experience\b/i,
    /\bextensive experience\b/i,
    /\b(senior|expert in|specialist in)\b/i,
    /\bled a (department|company|business unit)\b/i,
    /\bmanaged a budget\b/i,
  ];
  if (!hasExperience) {
    OVERCLAIM.push(
      /\b(my|the)\s+(one|two|three|four|five|several|\d+)\s+years?\s+(at|with|working)\b/i,
      /\bi\s+(worked|interned|was employed|was contracted)\s+(at|for|with)\b/i,
      /\bduring my (time|tenure|employment|internship) (at|with)\b/i,
      /\bmy (previous |former )?(employer|role at|position at|job at)\b/i,
    );
  }
  for (const re of OVERCLAIM) {
    const m = answer.match(re);
    if (m) { notes.push(`overclaims: "${m[0]}"`); break; }
  }

  return { passed: notes.length === 0, notes };
}

export async function generateAnswer(o: GenerateOptions): Promise<GenerationResult> {
  const qh = questionHash(o.question);
  const db = getDb();

  // Reuse an answer already written and validated for this org + question.
  const prior = db.prepare(
    `SELECT id, answer_text, source_refs_json, cost_usd FROM generations
     WHERE question_hash = ? AND organisation IS ? AND validator_passed = 1
     ORDER BY created_at DESC LIMIT 1`,
  ).get(qh, o.organisation ?? null) as
    { id: string; answer_text: string; source_refs_json: string; cost_usd: number } | undefined;

  if (prior) {
    logger.info({ question: o.question.slice(0, 50) }, 'reusing a previously validated answer - no AI call');
    return {
      id: prior.id, answer: prior.answer_text,
      sourceRefs: JSON.parse(prior.source_refs_json) as string[],
      validatorPassed: true, validatorNotes: [], costUsd: 0, reused: true,
    };
  }

  const facts = factSheet(o.profile);
  // The advert is legitimate source material for naming the organisation and role.
  const contextText = [o.organisation, o.opportunityTitle, o.opportunityContext].filter(Boolean).join(" ");
  let prompt = buildPrompt(o, facts);
  let totalCost = 0;
  let last: { gen: Generation; notes: string[] } | null = null;

  // Two attempts: the violation is quoted back so the model can drop the claim
  // rather than reword around it.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await askJson(prompt, GenerationSchema, {
      purpose: 'generate.answer',
      ...(o.runId ? { runId: o.runId } : {}),
      ...(o.applicationId ? { applicationId: o.applicationId } : {}),
    });
    totalCost += res.usage.costUsd;

    const v = validate(res.value.answer, res.value.source_refs, o.profile, contextText);
    last = { gen: res.value, notes: v.notes };

    if (v.passed) {
      const id = randomUUID();
      db.prepare(`
        INSERT INTO generations (id, kind, question_text, question_hash, organisation,
          answer_text, source_refs_json, validator_passed, model, cost_usd)
        VALUES (?, 'ANSWER', ?, ?, ?, ?, ?, 1, 'cheap', ?)
      `).run(id, o.question, qh, o.organisation ?? null, res.value.answer,
        JSON.stringify(res.value.source_refs), totalCost);
      logger.info({ words: res.value.answer.split(/\s+/).length, cost: totalCost }, 'answer generated');
      return {
        id, answer: res.value.answer, sourceRefs: res.value.source_refs,
        validatorPassed: true, validatorNotes: [], costUsd: totalCost, reused: false,
      };
    }

    logger.warn({ attempt, notes: v.notes }, 'generated answer failed fact validation');
    prompt = `${buildPrompt(o, facts)}

--- YOUR PREVIOUS ANSWER WAS REJECTED ---
${res.value.answer}

UNSUPPORTED CLAIMS:
${v.notes.map((n) => `- ${n}`).join('\n')}

Rewrite it. REMOVE each unsupported claim entirely - do not rephrase it, do not
replace it with a vaguer version of the same claim. A shorter, entirely true
answer is the correct outcome.`;
  }

  // Twice-failed generation becomes a human task, never a submitted guess.
  const id = randomUUID();
  db.prepare(`
    INSERT INTO generations (id, kind, question_text, question_hash, organisation,
      answer_text, source_refs_json, validator_passed, validator_notes, model, cost_usd)
    VALUES (?, 'ANSWER', ?, ?, ?, ?, ?, 0, ?, 'cheap', ?)
  `).run(id, o.question, qh, o.organisation ?? null, last!.gen.answer,
    JSON.stringify(last!.gen.source_refs), last!.notes.join('; '), totalCost);

  return {
    id, answer: last!.gen.answer, sourceRefs: last!.gen.source_refs,
    validatorPassed: false, validatorNotes: last!.notes, costUsd: totalCost, reused: false,
  };
}
