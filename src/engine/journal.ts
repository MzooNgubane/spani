import { randomUUID } from 'node:crypto';
import { getDb } from '../core/db.js';
import { logger } from '../core/logger.js';

/**
 * The step journal. Resume depends entirely on this being written BEFORE the
 * action, not after.
 *
 * The rule that matters most:
 *   A SUBMIT step found in RUNNING state on restart is NEVER retried.
 * We crashed between clicking submit and confirming it. The application may
 * well have gone through. Retrying risks a duplicate submission in the
 * person's name, so it becomes a question for them instead.
 */

export type StepKind =
  | 'NAVIGATE' | 'LOGIN' | 'SNAPSHOT' | 'FILL' | 'UPLOAD' | 'GENERATE'
  | 'VERIFY_HUMAN' | 'NEXT_PAGE' | 'SUBMIT' | 'CONFIRM';

export type StepState = 'PENDING' | 'RUNNING' | 'DONE' | 'BLOCKED' | 'FAILED' | 'SKIPPED';

export interface Step {
  id: string;
  applicationId: string;
  seq: number;
  kind: StepKind;
  state: StepState;
  pageUrl?: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

export class Journal {
  constructor(readonly applicationId: string) {}

  private nextSeq(): number {
    const r = getDb().prepare(
      'SELECT COALESCE(MAX(seq), 0) AS m FROM application_steps WHERE application_id = ?',
    ).get(this.applicationId) as { m: number };
    return r.m + 1;
  }

  /** Write the intent before doing it. A crash then leaves a RUNNING row. */
  begin(kind: StepKind, payload?: Record<string, unknown>, pageUrl?: string): Step {
    const step: Step = {
      id: randomUUID(), applicationId: this.applicationId, seq: this.nextSeq(),
      kind, state: 'RUNNING',
      ...(pageUrl ? { pageUrl } : {}), ...(payload ? { payload } : {}),
    };
    getDb().prepare(`
      INSERT INTO application_steps (id, application_id, seq, step_kind, page_url, state,
        payload_json, started_at)
      VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, datetime('now'))
    `).run(step.id, this.applicationId, step.seq, kind, pageUrl ?? null,
      payload ? JSON.stringify(payload) : null);
    logger.debug({ step: kind, seq: step.seq }, 'step begin');
    return step;
  }

  finish(step: Step, state: Exclude<StepState, 'RUNNING' | 'PENDING'>,
    result?: Record<string, unknown>, error?: string): void {
    getDb().prepare(`
      UPDATE application_steps SET state = ?, result_json = ?, error_text = ?,
        finished_at = datetime('now') WHERE id = ?
    `).run(state, result ? JSON.stringify(result) : null, error ?? null, step.id);
    logger.debug({ step: step.kind, seq: step.seq, state }, 'step end');
  }

  steps(): Step[] {
    const rows = getDb().prepare(
      'SELECT * FROM application_steps WHERE application_id = ? ORDER BY seq',
    ).all(this.applicationId) as Array<Record<string, string | number | null>>;
    return rows.map((r) => ({
      id: r['id'] as string,
      applicationId: r['application_id'] as string,
      seq: r['seq'] as number,
      kind: r['step_kind'] as StepKind,
      state: r['state'] as StepState,
      ...(r['page_url'] ? { pageUrl: r['page_url'] as string } : {}),
      ...(r['payload_json'] ? { payload: JSON.parse(r['payload_json'] as string) } : {}),
      ...(r['result_json'] ? { result: JSON.parse(r['result_json'] as string) } : {}),
      ...(r['error_text'] ? { error: r['error_text'] as string } : {}),
    }));
  }

  lastDone(): Step | null {
    const done = this.steps().filter((s) => s.state === 'DONE');
    return done.length ? done[done.length - 1]! : null;
  }
}

export type ResumeDecision =
  | { action: 'START' }
  | { action: 'RESUME'; fromSeq: number }
  | { action: 'ASK_HUMAN'; reason: string; step: Step }
  | { action: 'ALREADY_DONE' };

/**
 * What to do with an application that was interrupted.
 *
 * Deliberately conservative around SUBMIT. Everything else is safe to redo
 * because filling a field twice is harmless; submitting twice is not.
 */
export function decideResume(journal: Journal): ResumeDecision {
  const steps = journal.steps();
  if (!steps.length) return { action: 'START' };

  const confirmed = steps.find((s) => s.kind === 'CONFIRM' && s.state === 'DONE');
  if (confirmed) return { action: 'ALREADY_DONE' };

  const submitted = steps.find((s) => s.kind === 'SUBMIT' && s.state === 'DONE');
  if (submitted) {
    return {
      action: 'ASK_HUMAN', step: submitted,
      reason: 'The submit button was clicked but the confirmation was never recorded. ' +
        'Please check whether this application went through before I try again.',
    };
  }

  const interruptedSubmit = steps.find((s) => s.kind === 'SUBMIT' && s.state === 'RUNNING');
  if (interruptedSubmit) {
    return {
      action: 'ASK_HUMAN', step: interruptedSubmit,
      reason: 'I was interrupted mid-submit. The application may or may not have been sent. ' +
        'Please check the site or your email before I retry - I will not risk a duplicate.',
    };
  }

  const blocked = steps.find((s) => s.state === 'BLOCKED');
  if (blocked) return { action: 'RESUME', fromSeq: blocked.seq };

  const last = journal.lastDone();
  return last ? { action: 'RESUME', fromSeq: last.seq + 1 } : { action: 'START' };
}
