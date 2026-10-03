import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { PATHS, ensureDataDirs } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getDb, closeDb } from '../core/db.js';
import { askJson, resolveCliPath, spentLast24h } from '../ai/client.js';
import { loadProfile, unknownPaths, promptablePaths, isBlockingPath, BLOCKING_REASONS } from '../profile/index.js';
import { loadManifest, ingest, matchDocument } from '../documents/index.js';

const commands: Record<string, () => Promise<void>> = {
  doctor, status, ingest: ingestCmd, review, profile: profileCmd,
  'match-doc': matchDoc, snapshot: snapshotCmd, 'dry-run': dryRunCmd, answer: answerCmd, dashboard: dashboardCmd, apply: applyCmd, nightly: nightlyCmd, add: addCmd, queue: queueCmd, mail: mailCmd,
};

const ICON: Record<string, string> = {
  FILLED: '✓', SKIPPED: '·', ESCALATED: '?', FAILED: '✗', NEEDS_GENERATION: '✎',
};

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'doctor';
  const fn = commands[cmd];
  if (!fn) {
    console.error(`Unknown command: ${cmd}\nAvailable: ${Object.keys(commands).join(', ')}`);
    process.exit(1);
  }
  await fn();
  closeDb();
}

const rule = (n = 74) => '  ' + '─'.repeat(n);

async function doctor(): Promise<void> {
  const checks: Array<[string, boolean, string]> = [];
  const cfg = loadConfig();

  ensureDataDirs();
  checks.push(['data directories', fs.existsSync(PATHS.data), PATHS.data]);
  checks.push(['node >= 22', Number(process.versions.node.split('.')[0]) >= 22, `v${process.versions.node}`]);

  const db = getDb();
  const tables = db.prepare(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  ).get() as { n: number };
  checks.push(['sqlite schema', tables.n >= 14, `${tables.n} tables`]);

  const cli = resolveCliPath();
  checks.push(['claude cli', fs.existsSync(cli) || cli === 'claude', cli]);

  const leaked = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter((k) => process.env[k]);
  checks.push(['no api key in env', leaked.length === 0,
    leaked.length ? `FOUND ${leaked.join(', ')} - would bill the API` : 'clean (subscription billing)']);

  try {
    const p = loadProfile(true);
    const unknown = unknownPaths(p).length;
    checks.push(['profile', true,
      `${p.personal.first_name} ${p.personal.surname} - ${promptablePaths(p).length} paths, ` +
      `${unknown} unknown, verified=${p.meta.verified_by_human}`]);
  } catch (e) {
    checks.push(['profile', false, e instanceof Error ? e.message.split('\n')[0]! : String(e)]);
  }

  try {
    const m = loadManifest();
    const v = m.documents.filter((d) => d.verified).length;
    checks.push(['document manifest', true, `${m.documents.length} documents, ${v} verified`]);
  } catch (e) {
    checks.push(['document manifest', false, e instanceof Error ? e.message.split('\n')[0]! : String(e)]);
  }

  let bridgeOk = false;
  let bridge = '';
  try {
    const res = await askJson(
      'Reply with ONLY this JSON object and nothing else: {"ok": true, "service": "spani"}',
      z.object({ ok: z.literal(true), service: z.string() }),
      { purpose: 'doctor.bridge' },
    );
    bridgeOk = res.value.ok;
    bridge = `ok - $${res.usage.costUsd.toFixed(4)} notional, ${res.usage.durationMs}ms`;
  } catch (e) {
    bridge = e instanceof Error ? e.message : String(e);
  }
  checks.push(['claude bridge', bridgeOk, bridge]);

  const spent = spentLast24h();
  checks.push(['budget (24h)', spent < cfg.budget.perDayUsd,
    `$${spent.toFixed(4)} of $${cfg.budget.perDayUsd.toFixed(2)} cap`]);

  console.log('\n  SPANI DOCTOR\n' + rule());
  for (const [name, ok, detail] of checks) console.log(`  ${ok ? '✓' : '✗'}  ${name.padEnd(20)} ${detail}`);
  console.log(rule());
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`  ${passed}/${checks.length} passed\n`);
  if (!bridgeOk || leaked.length) process.exitCode = 1;
}

async function ingestCmd(): Promise<void> {
  const r = ingest();
  console.log('\n  DOCUMENT INGEST\n' + rule());
  console.log(`  inserted: ${r.inserted}   updated: ${r.updated}`);
  if (r.missing.length) {
    console.log(`\n  ✗ listed in manifest but NOT on disk (${r.missing.length}):`);
    for (const f of r.missing) console.log(`      ${f}`);
  }
  if (r.unlisted.length) {
    console.log(`\n  ? on disk but NOT in manifest (${r.unlisted.length}):`);
    for (const f of r.unlisted) console.log(`      ${f}`);
  }
  console.log('');
}

/** The consolidated checklist for one review sitting. */
async function review(): Promise<void> {
  const profile = loadProfile(true);
  const m = loadManifest();

  console.log('\n  REVIEW CHECKLIST — everything blocking full autonomy\n' + rule());

  const unknown = unknownPaths(profile);
  const blocking = unknown.filter(isBlockingPath);
  const optional = unknown.filter((p) => !isBlockingPath(p));

  console.log(`\n  ■ PROFILE — ${blocking.length} blocking, ${optional.length} optional`);
  console.log('    (null means UNKNOWN; the agent escalates rather than guessing)\n');
  console.log(`    BLOCKING — commonly asked; a null here stalls applications\n`);
  for (const p of blocking) {
    console.log(`      ${p.padEnd(42)} ${BLOCKING_REASONS[p] ?? ''}`);
  }
  console.log(`\n    OPTIONAL — fill in if you want, rarely asked (${optional.length})`);
  console.log(`      ${optional.slice(0, 8).join(', ')}${optional.length > 8 ? `, +${optional.length - 8} more` : ''}`);

  const unverified = m.documents.filter((d) => !d.verified);
  const questions = m.documents.filter((d) => d.open_question);
  console.log(`\n  ■ DOCUMENTS — ${unverified.length}/${m.documents.length} unverified, ${questions.length} open questions\n`);
  for (const d of questions) {
    console.log(`    ${d.key}  (${d.file})`);
    console.log(`        ${d.open_question!.replace(/\s+/g, ' ').trim()}`);
  }

  const encrypted = m.documents.filter((d) => d.encrypted);
  if (encrypted.length) {
    console.log(`\n  ■ PASSWORD-PROTECTED — cannot be uploaded as-is\n`);
    for (const d of encrypted) console.log(`    ${d.file}  →  open in Chrome, Print → Save as PDF`);
  }

  const thirdParty = m.documents.filter((d) => d.third_party);
  console.log(`\n  ■ THIRD-PARTY DATA — ${thirdParty.length} files, always RED tier\n`);
  console.log(`    ${thirdParty.map((d) => d.key).join(', ')}`);

  console.log(`\n${rule()}`);
  console.log(`  Blocking submission: profile.meta.verified_by_human = ${profile.meta.verified_by_human}\n`);
}

async function profileCmd(): Promise<void> {
  const p = loadProfile(true);
  const paths = promptablePaths(p);
  console.log(`\n  PROFILE — ${p.personal.first_name} ${p.personal.surname}\n` + rule());
  console.log(`  paths: ${paths.length}   known: ${paths.filter((x) => x.known).length}   ` +
    `unknown: ${paths.filter((x) => !x.known).length}   sensitive: ${paths.filter((x) => x.sensitive).length}`);
  console.log(`  verified_by_human: ${p.meta.verified_by_human}\n`);
}

/** Probe the document matcher: spani match-doc "Upload certified ID copy" */
async function matchDoc(): Promise<void> {
  const label = process.argv.slice(3).join(' ');
  if (!label) { console.error('usage: match-doc <field label>'); process.exitCode = 1; return; }
  const r = matchDocument(label);
  console.log(`\n  "${label}"\n` + rule());
  if (r.best) console.log(`  ✓ ${r.best.entry.key}  →  ${r.best.entry.file}  (${r.best.score.toFixed(2)}, ${r.best.reason})`);
  else console.log(`  ⏸ BLOCKED: ${r.blocked}`);
  if (r.candidates.length) {
    console.log('\n  candidates:');
    for (const c of r.candidates) console.log(`      ${c.score.toFixed(2)}  ${c.entry.key.padEnd(30)} ${c.reason}`);
  }
  console.log('');
}

/** Open a URL or fixture and print the semantic snapshot Claude would receive. */
async function snapshotCmd(): Promise<void> {
  const target = process.argv[3];
  if (!target) { console.error('usage: snapshot <url|fixture.html>'); process.exitCode = 1; return; }
  const url = /^https?:|^file:/.test(target)
    ? target
    : pathToFileURL(path.resolve(PATHS.fixtures, target)).href;

  const { newPage, closeSession } = await import('../browser/session.js');
  const { snapshotPage, snapshotForPrompt } = await import('../browser/snapshot.js');

  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const snap = await snapshotPage(page);
    const prompt = snapshotForPrompt(snap);

    console.log(`\n  SNAPSHOT  ${snap.url}\n` + rule());
    console.log(`  title      ${snap.title}`);
    console.log(`  heading    ${snap.heading ?? '-'}`);
    console.log(`  signature  ${snap.signature}`);
    console.log(`  fields     ${snap.fields.length}   buttons ${snap.buttons.length}   errors ${snap.errors.length}`);
    console.log(`  prompt     ${prompt.length} chars  ~${Math.ceil(prompt.length / 3.6)} tokens\n`);
    for (const f of snap.fields) {
      const req = f.required ? '*' : ' ';
      const opts = f.options?.length ? `  [${f.options.slice(0, 4).join(' | ')}${f.options.length > 4 ? ' …' : ''}]` : '';
      console.log(`  ${req} ${f.ref.padEnd(6)} ${f.kind.padEnd(9)} ${f.label.slice(0, 46).padEnd(48)}${opts}`);
    }
    console.log('');
  } finally {
    await closeSession();
  }
}

/** Full pipeline, nothing written, nothing submitted. */
async function dryRunCmd(): Promise<void> {
  const target = process.argv[3];
  if (!target) { console.error('usage: dry-run <url|fixture.html> [--fresh]'); process.exitCode = 1; return; }
  const url = /^https?:|^file:/.test(target)
    ? target
    : pathToFileURL(path.resolve(PATHS.fixtures, target)).href;

  const { dryRun } = await import('../engine/dryrun.js');
  const r = await dryRun(url, { fresh: process.argv.includes('--fresh') });

  console.log(`\n  DRY RUN  ${r.siteKey}\n` + rule());
  console.log(`  url        ${r.url}`);
  console.log(`  signature  ${r.signature}`);
  console.log(`  fields     ${r.fields}   fieldmap ${r.cacheHit ? 'CACHE HIT (no AI call)' : 'built via Claude'}`);
  console.log(`  cost       $${r.costUsd.toFixed(4)} notional`);
  if (r.verification) console.log(`  ⚠ verification detected: ${r.verification}`);
  console.log('');

  for (const o of r.outcomes) {
    const tail = o.status === 'FILLED'
      ? `← ${o.profilePath ?? o.documentKey ?? o.valueSource}`
      : o.reason ?? '';
    console.log(`  ${ICON[o.status] ?? ' '} ${o.label.slice(0, 44).padEnd(46)} ${tail.slice(0, 60)}`);
  }

  const counts = r.outcomes.reduce<Record<string, number>>((a, o) => {
    a[o.status] = (a[o.status] ?? 0) + 1; return a;
  }, {});
  console.log('\n' + rule());
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('   ')}`);
  if (r.rejected.length) {
    console.log(`\n  model output corrected on ${r.rejected.length} field(s):`);
    for (const x of r.rejected.slice(0, 10)) console.log(`      ${x.ref}  ${x.why}`);
  }
  console.log(`\n  screenshot ${r.screenshotPath}\n`);
}

/** Generate one application answer and show the fact-validation result. */
async function answerCmd(): Promise<void> {
  const question = process.argv.slice(3).filter((a) => !a.startsWith('--')).join(' ');
  if (!question) { console.error('usage: answer \"<question>\" [--org Name]'); process.exitCode = 1; return; }
  const orgIdx = process.argv.indexOf('--org');
  const org = orgIdx > -1 ? process.argv[orgIdx + 1] : undefined;

  const { generateAnswer } = await import('../engine/generate.js');
  const r = await generateAnswer({
    question, maxWords: 200, profile: loadProfile(),
    ...(org ? { organisation: org } : {}),
  });

  const wrapped = r.answer.replace(/(.{1,72})(\s|$)/g, '$1\n  ').trimEnd();
  console.log(`\n  ANSWER ${r.reused ? '(reused — no AI call)' : ''}\n` + rule());
  console.log(`  ${wrapped}`);
  console.log(rule());
  console.log(`  validator  ${r.validatorPassed
    ? 'PASSED — every claim traced to your profile'
    : 'FAILED — would become a human task, not a submission'}`);
  for (const n of r.validatorNotes) console.log(`      ✗ ${n}`);
  console.log(`  sources    ${r.sourceRefs.join(', ')}`);
  console.log(`  words      ${r.answer.split(/\s+/).length}`);
  console.log(`  cost       $${r.costUsd.toFixed(4)} notional\n`);
}

async function status(): Promise<void> {
  const db = getDb();
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM applications GROUP BY status')
    .all() as Array<{ status: string; n: number }>;
  const open = db.prepare(`SELECT COUNT(*) AS n FROM human_tasks WHERE state = 'OPEN'`).get() as { n: number };
  const opps = db.prepare('SELECT COUNT(*) AS n FROM opportunities').get() as { n: number };
  const docs = db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number };

  console.log('\n  APPLICATION AGENT\n' + rule(40));
  console.log(`  Opportunities:            ${opps.n}`);
  for (const c of counts) console.log(`  ${c.status.padEnd(24)}  ${c.n}`);
  console.log(`  Human action required:    ${open.n}`);
  console.log(`  Documents indexed:        ${docs.n}`);
  console.log(`  Spent (24h, notional):    $${spentLast24h().toFixed(4)}\n`);
}

main().catch((e) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, 'cli failed');
  console.error(`\n  ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

async function dashboardCmd(): Promise<void> {
  const { startServer } = await import('../server/index.js');
  const port = Number(process.env['SPANI_PORT'] ?? 4317);
  await startServer(port);
  console.log(`\n  Dashboard → http://127.0.0.1:${port}\n  Ctrl+C to stop.\n`);
  await new Promise(() => { /* run until interrupted */ });
}

/** Drive a real application up to (but never through) the submit button. */
async function applyCmd(): Promise<void> {
  const target = process.argv[3];
  if (!target) { console.error('usage: apply <url|fixture.html> [--live] [--org Name] [--title T]'); process.exitCode = 1; return; }
  const url = /^https?:|^file:/.test(target)
    ? target
    : pathToFileURL(path.resolve(PATHS.fixtures, target)).href;
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : undefined;
  };

  const { apply } = await import('../engine/apply.js');
  const r = await apply({
    url,
    live: process.argv.includes('--live'),
    ...(arg('--org') ? { organisation: arg('--org')! } : {}),
    ...(arg('--title') ? { title: arg('--title')! } : {}),
  });

  console.log(`\n  APPLY  ${r.applicationId.slice(0, 8)}\n` + rule());
  console.log(`  status        ${r.status}`);
  console.log(`  pages         ${r.pagesProcessed}`);
  console.log(`  submit gate   ${r.submitReady ? 'reached — stopped, awaiting your approval' : 'not reached'}`);
  console.log(`  cost          $${r.costUsd.toFixed(4)} notional`);
  if (r.blockedBy) console.log(`  blocked by    ${r.blockedBy}`);
  console.log('');
  for (const o of r.outcomes) {
    const tail = o.status === 'FILLED' ? `← ${o.profilePath ?? o.documentKey ?? o.valueSource}` : (o.reason ?? '');
    console.log(`  ${ICON[o.status] ?? ' '} ${o.label.slice(0, 42).padEnd(44)} ${tail.slice(0, 58)}`);
  }
  const counts = r.outcomes.reduce<Record<string, number>>((a, o) => {
    a[o.status] = (a[o.status] ?? 0) + 1; return a;
  }, {});
  console.log('\n' + rule());
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('   ')}`);
  console.log(`  screenshots   ${r.screenshots.length}\n`);
}

/**
 * The unattended nightly run.
 *
 * Deliberately refuses to do anything while setup is incomplete. An agent
 * that starts filling real applications from an unverified profile is worse
 * than one that does nothing.
 */
async function nightlyCmd(): Promise<void> {
  const cfg = loadConfig();
  const started = Date.now();
  const db = getDb();

  const profile = loadProfile(true);
  const manifest = loadManifest();
  const blockers: string[] = [];
  if (!profile.meta.verified_by_human) blockers.push('profile is not human-verified');
  if (!manifest.documents.some((d) => d.verified)) blockers.push('no documents are verified');

  if (blockers.length) {
    logger.warn({ blockers }, 'nightly run skipped - setup incomplete');
    console.log(`\n  Nightly run skipped:\n${blockers.map((b) => `    · ${b}`).join('\n')}`);
    console.log(`\n  Run: npm run spani -- review\n`);
    return;
  }

  const spent = spentLast24h();
  if (spent >= cfg.budget.perDayUsd) {
    logger.warn({ spent, cap: cfg.budget.perDayUsd }, 'nightly run skipped - 24h budget already spent');
    return;
  }

  // Resume anything parked before starting anything new: an application with
  // a closing date is worth more than a freshly discovered one.
  const resumable = db.prepare(`
    SELECT a.id, o.url, o.title, o.organisation FROM applications a
    JOIN opportunities o ON o.id = a.opportunity_id
    WHERE a.status IN ('IN_PROGRESS','NEEDS_REVIEW','PREPARING')
    ORDER BY o.closing_date IS NULL, o.closing_date
    LIMIT ?
  `).all(profile.policy.max_applications_per_day) as Array<Record<string, string>>;

  const { apply } = await import('../engine/apply.js');
  let done = 0;

  for (const row of resumable) {
    if (spentLast24h() >= cfg.budget.perDayUsd) {
      logger.warn('budget cap reached - stopping cleanly, remaining work stays queued');
      break;
    }
    try {
      const r = await apply({
        url: row['url']!, live: true,
        ...(row['title'] ? { title: row['title'] } : {}),
        ...(row['organisation'] ? { organisation: row['organisation'] } : {}),
      });
      done++;
      logger.info({ app: r.applicationId, status: r.status, cost: r.costUsd }, 'nightly application done');
    } catch (e) {
      logger.error({ url: row['url'], err: e instanceof Error ? e.message : String(e) },
        'nightly application failed - left resumable');
    }
  }

  const mins = Math.round((Date.now() - started) / 60_000);
  logger.info({ processed: done, minutes: mins, spent: spentLast24h() }, 'nightly run complete');
  console.log(`\n  Nightly run: ${done} application(s), ${mins} min, $${spentLast24h().toFixed(3)} notional.\n`);
}

/** Take in an opportunity by URL and immediately assess eligibility. */
async function addCmd(): Promise<void> {
  const url = process.argv[3];
  if (!url) { console.error('usage: add <url> [--title T] [--org O] [--type BURSARY] [--closing YYYY-MM-DD]'); process.exitCode = 1; return; }
  const arg = (n: string): string | undefined => {
    const i = process.argv.indexOf(n);
    return i > -1 ? process.argv[i + 1] : undefined;
  };

  const { intake } = await import('../discovery/intake.js');
  const r = await intake({
    url,
    ...(arg('--title') ? { title: arg('--title')! } : {}),
    ...(arg('--org') ? { organisation: arg('--org')! } : {}),
    ...(arg('--type') ? { type: arg('--type')! } : {}),
    ...(arg('--closing') ? { closingDate: arg('--closing')! } : {}),
  });

  console.log(`\n${r.explanation}\n`);
  console.log(rule());
  console.log(`  cost  $${r.assessment.costUsd.toFixed(4)} notional   ${r.fresh ? 'new' : 'already known'}\n`);
}

/** What the agent would work on next, in order. */
async function queueCmd(): Promise<void> {
  const rows = getDb().prepare(`
    SELECT o.title, o.organisation, o.type, o.closing_date, a.status, a.risk_tier, o.url
    FROM applications a JOIN opportunities o ON o.id = a.opportunity_id
    ORDER BY CASE a.status WHEN 'ELIGIBLE' THEN 0 WHEN 'NEEDS_REVIEW' THEN 1
             WHEN 'IN_PROGRESS' THEN 2 WHEN 'AWAITING_APPROVAL' THEN 3
             WHEN 'SUBMITTED' THEN 5 ELSE 4 END,
             o.closing_date IS NULL, o.closing_date
  `).all() as Array<Record<string, string | null>>;

  console.log(`\n  QUEUE — ${rows.length} opportunit${rows.length === 1 ? 'y' : 'ies'}\n` + rule());
  if (!rows.length) console.log('  Nothing taken in yet. Use: npm run spani -- add <url>');
  for (const r of rows) {
    const days = r['closing_date']
      ? Math.ceil((new Date(r['closing_date']).getTime() - Date.now()) / 86_400_000)
      : null;
    const when = days === null ? '' : days < 0 ? `CLOSED ${-days}d ago` : `${days}d left`;
    console.log(`  ${(r['status'] ?? '').padEnd(16)} ${(r['title'] ?? '').slice(0, 42).padEnd(44)} ${when}`);
    console.log(`  ${''.padEnd(16)} ${r['organisation'] ?? ''}  ${r['url']?.slice(0, 60) ?? ''}`);
  }
  console.log('');
}

/**
 * Check the agent's browser can read your mailbox, and optionally search it.
 *   mail                → is the agent signed in?
 *   mail <hint>         → look for a verification email mentioning <hint>
 */
async function mailCmd(): Promise<void> {
  const hint = process.argv.slice(3).join(' ');
  const { checkMailbox, findVerification } = await import('../email/browser-mail.js');
  const { newPage, closeSession } = await import('../browser/session.js');

  const page = await newPage();
  try {
    const status = await checkMailbox(page);
    console.log(`\n  MAILBOX\n` + rule());
    console.log(`  ${status.signedIn ? '✓' : '✗'}  ${status.detail}`);

    if (!status.signedIn) {
      console.log(`
  The agent's Chrome window is open on the Gmail sign-in page.
  Sign in there now, by hand, once. The session is saved in the agent's own
  profile and survives every future run - no password is stored anywhere.

  Leaving the window open, run this again to confirm.
`);
      // Hold the window open so they can actually sign in.
      await page.waitForTimeout(120_000);
      const again = await checkMailbox(page);
      console.log(`  ${again.signedIn ? '✓' : '✗'}  ${again.detail}\n`);
      return;
    }

    if (hint) {
      console.log(`\n  Searching for a verification email matching "${hint}"…`);
      const found = await findVerification({ hint, timeoutMs: 45_000 }, page);
      if (!found) {
        console.log(`  nothing found in the last day\n`);
      } else {
        console.log(`\n  from     ${found.from}`);
        console.log(`  subject  ${found.subject}`);
        console.log(`  link     ${found.link ?? '-'}`);
        console.log(`  code     ${found.code ?? '-'}\n`);
      }
    } else {
      console.log(`
  Email verification will work unattended.
  Try: npm run spani -- mail "isfap"
`);
    }
  } finally {
    await closeSession();
  }
}
