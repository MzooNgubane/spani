import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { detectVerification, waitForVerification } from '../src/browser/verification.js';
import { snapshotPage, signatureOf } from '../src/browser/snapshot.js';

const fixture = (name: string) =>
  pathToFileURL(path.resolve(process.cwd(), 'fixtures', name)).href;

let browser: Browser;
let page: Page;

// Headless here on purpose: these assert detector logic, not the real
// hand-over, and the real session must stay headed. Uses the installed Chrome
// channel so we test the same engine the agent runs, and skip a 120MB download.
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

describe('snapshot extractor', () => {
  test('collapses radio groups and keeps options', async () => {
    page = await browser.newPage();
    await page.goto(fixture('01-bursary-simple.html'));
    const snap = await snapshotPage(page);

    const citizen = snap.fields.find((f) => f.label.includes('South African citizen'));
    assert.ok(citizen, 'citizenship radio group present');
    assert.equal(citizen!.kind, 'radio');
    assert.deepEqual(citizen!.options, ['Yes', 'No']);
    assert.equal(citizen!.required, true);

    const province = snap.fields.find((f) => f.label === 'Home province');
    assert.ok(province!.options!.includes('KwaZulu-Natal'));
    // The "-- Please select --" placeholder must not become a real option.
    assert.ok(!province!.options!.some((o) => o.includes('Please select')));

    assert.equal(snap.fields.filter((f) => f.kind === 'file').length, 7);
    await page.close();
  });

  test('signature is stable across loads but changes with the form', async () => {
    const p1 = await browser.newPage();
    await p1.goto(fixture('01-bursary-simple.html'));
    const a = (await snapshotPage(p1)).signature;
    await p1.goto(fixture('01-bursary-simple.html'));
    const b = (await snapshotPage(p1)).signature;
    assert.equal(a, b, 'same form, same signature');

    await p1.goto(fixture('02-multistep-captcha.html'));
    const c = (await snapshotPage(p1)).signature;
    assert.notEqual(a, c, 'different form, different signature');
    await p1.close();
  });

  test('signature ignores entered values', () => {
    const fields = [
      { ref: 'f1', label: 'Email', kind: 'email' as const, required: true },
      { ref: 'f2', label: 'Name', kind: 'text' as const, required: true },
    ];
    const withValues = fields.map((f) => ({ ...f, value: 'something typed' }));
    assert.equal(
      signatureOf(fields, 'https://x.test/a'),
      signatureOf(withValues, 'https://x.test/a'),
    );
  });
});

describe('human verification', () => {
  test('detects a CAPTCHA widget', async () => {
    page = await browser.newPage();
    await page.goto(fixture('02-multistep-captcha.html'));
    await page.click('#p1 button');
    await page.click('#p2 button');

    const v = await detectVerification(page);
    assert.ok(v, 'verification detected');
    assert.equal(v!.kind, 'CAPTCHA');
    assert.equal(v!.clearedWhen, 'TOKEN_PRESENT');
    await page.close();
  });

  test('does not fire on an ordinary form', async () => {
    const p = await browser.newPage();
    await p.goto(fixture('01-bursary-simple.html'));
    assert.equal(await detectVerification(p), null);
    await p.close();
  });

  // The core promise: the human ticks the box, the agent notices unaided and
  // takes control back. No manual driving of the remaining steps.
  test('resumes automatically once the human solves it', async () => {
    const p = await browser.newPage();
    await p.goto(fixture('02-multistep-captcha.html'));
    await p.click('#p1 button');
    await p.click('#p2 button');

    const v = (await detectVerification(p))!;
    setTimeout(() => { void p.check('#robot').catch(() => {}); }, 900);

    const res = await waitForVerification(p, v, { timeoutMs: 10_000, pollMs: 200 });
    assert.equal(res.cleared, true, res.reason);
    assert.match(res.reason, /token present|no longer present/);
    assert.ok(res.waitedMs < 10_000);
    await p.close();
  });

  test('times out rather than hanging forever', async () => {
    const p = await browser.newPage();
    await p.goto(fixture('02-multistep-captcha.html'));
    await p.click('#p1 button');
    await p.click('#p2 button');

    const v = (await detectVerification(p))!;
    const res = await waitForVerification(p, v, { timeoutMs: 1500, pollMs: 200 });
    assert.equal(res.cleared, false);
    assert.match(res.reason, /timed out/);
    await p.close();
  });
});
