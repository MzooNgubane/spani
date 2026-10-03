import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDb } from '../src/core/db.js';
import { Journal, decideResume } from '../src/engine/journal.js';

/** A throwaway application row so the journal's foreign keys hold. */
function makeApplication(): string {
  const db = getDb();
  const oppId = randomUUID();
  const appId = randomUUID();
  db.prepare(`
    INSERT INTO opportunities (id, source, url, url_canonical, title, type)
    VALUES (?, 'TEST', ?, ?, 'Test opportunity', 'BURSARY')
  `).run(oppId, `https://test.invalid/${oppId}`, `https://test.invalid/${oppId}`);
  db.prepare(`INSERT INTO applications (id, opportunity_id, status) VALUES (?, ?, 'IN_PROGRESS')`)
    .run(appId, oppId);
  return appId;
}

let journal: Journal;
beforeEach(() => { journal = new Journal(makeApplication()); });

describe('step journal', () => {
  test('a fresh application starts', () => {
    assert.deepEqual(decideResume(journal), { action: 'START' });
  });

  test('resumes after the last completed step', () => {
    const a = journal.begin('NAVIGATE');
    journal.finish(a, 'DONE');
    const b = journal.begin('FILL');
    journal.finish(b, 'DONE');

    const d = decideResume(journal);
    assert.equal(d.action, 'RESUME');
    assert.equal((d as { fromSeq: number }).fromSeq, 3);
  });

  test('resumes AT a blocked step, not after it', () => {
    const a = journal.begin('NAVIGATE');
    journal.finish(a, 'DONE');
    const b = journal.begin('VERIFY_HUMAN');
    journal.finish(b, 'BLOCKED');

    const d = decideResume(journal);
    assert.equal(d.action, 'RESUME');
    assert.equal((d as { fromSeq: number }).fromSeq, b.seq, 'the blocked step itself is retried');
  });

  // The rule the whole journal exists for.
  test('never auto-retries a submit interrupted mid-flight', () => {
    const a = journal.begin('FILL');
    journal.finish(a, 'DONE');
    journal.begin('SUBMIT');          // left RUNNING: process died here

    const d = decideResume(journal);
    assert.equal(d.action, 'ASK_HUMAN');
    assert.match((d as { reason: string }).reason, /may or may not have been sent/);
  });

  test('a submit with no confirmation also asks rather than retrying', () => {
    const s = journal.begin('SUBMIT');
    journal.finish(s, 'DONE');        // clicked, but CONFIRM never recorded

    const d = decideResume(journal);
    assert.equal(d.action, 'ASK_HUMAN');
    assert.match((d as { reason: string }).reason, /never recorded/);
  });

  test('a confirmed submission is done and is not touched again', () => {
    const s = journal.begin('SUBMIT');
    journal.finish(s, 'DONE');
    const c = journal.begin('CONFIRM');
    journal.finish(c, 'DONE', { reference: 'ITB-2027-004182' });

    assert.deepEqual(decideResume(journal), { action: 'ALREADY_DONE' });
  });

  test('records payload, result and error round-trip', () => {
    const s = journal.begin('FILL', { fields: 12 }, 'https://test.invalid/page2');
    journal.finish(s, 'FAILED', { filled: 9 }, 'read-back mismatch on f7');

    const stored = journal.steps().find((x) => x.id === s.id)!;
    assert.equal(stored.state, 'FAILED');
    assert.equal(stored.pageUrl, 'https://test.invalid/page2');
    assert.deepEqual(stored.payload, { fields: 12 });
    assert.deepEqual(stored.result, { filled: 9 });
    assert.equal(stored.error, 'read-back mismatch on f7');
  });

  test('sequence numbers are contiguous and ordered', () => {
    for (const k of ['NAVIGATE', 'SNAPSHOT', 'FILL'] as const) {
      journal.finish(journal.begin(k), 'DONE');
    }
    assert.deepEqual(journal.steps().map((s) => s.seq), [1, 2, 3]);
  });
});

describe('duplicate application guard', () => {
  test('the database refuses a second application for one opportunity', () => {
    const db = getDb();
    const oppId = randomUUID();
    db.prepare(`
      INSERT INTO opportunities (id, source, url, url_canonical, title, type)
      VALUES (?, 'TEST', ?, ?, 'Dup test', 'BURSARY')
    `).run(oppId, `https://dup.invalid/${oppId}`, `https://dup.invalid/${oppId}`);

    db.prepare(`INSERT INTO applications (id, opportunity_id, status) VALUES (?, ?, 'SUBMITTED')`)
      .run(randomUUID(), oppId);

    assert.throws(
      () => db.prepare(`INSERT INTO applications (id, opportunity_id, status) VALUES (?, ?, 'PREPARING')`)
        .run(randomUUID(), oppId),
      /UNIQUE constraint failed/,
      'a duplicate application must be a database error, not a judgement call',
    );
  });
});
