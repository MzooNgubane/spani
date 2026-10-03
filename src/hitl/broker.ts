import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { Page } from 'playwright';
import { getDb } from '../core/db.js';
import { logger } from '../core/logger.js';
import { bringToFront, screenshot } from '../browser/session.js';
import { detectVerification, waitForVerification, type Verification } from '../browser/verification.js';

/**
 * The hand-over. Its whole job is to make an interruption cost ten seconds
 * instead of the rest of the application.
 *
 * Sequence: freeze -> raise the window -> say exactly what is needed ->
 * watch for completion -> resume from the journaled step. The person never
 * has to drive the remaining pages themselves.
 */

export type TaskKind =
  | 'CAPTCHA' | 'CLOUDFLARE' | 'OTP' | 'MFA' | 'EMAIL_VERIFY' | 'AMBIGUOUS_ELIGIBILITY'
  | 'MISSING_DOCUMENT' | 'MISSING_ANSWER' | 'APPROVE_SUBMIT' | 'SUBMIT_UNCERTAIN'
  | 'LOGIN_REQUIRED' | 'DOC_DISAMBIGUATION' | 'OTHER';

export interface HumanTask {
  id: string;
  kind: TaskKind;
  urgency: 'LOW' | 'NORMAL' | 'URGENT';
  prompt: string;
  applicationId?: string;
  context?: Record<string, unknown>;
  screenshotPath?: string;
}

export function openTask(t: Omit<HumanTask, 'id'>): string {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO human_tasks (id, application_id, kind, urgency, prompt, context_json, screenshot_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, t.applicationId ?? null, t.kind, t.urgency, t.prompt,
    t.context ? JSON.stringify(t.context) : null, t.screenshotPath ?? null);
  logger.warn({ taskId: id, kind: t.kind, urgency: t.urgency }, 'HUMAN ACTION REQUIRED');
  return id;
}

export function resolveTask(id: string, resolution: Record<string, unknown> = {}): void {
  getDb().prepare(
    `UPDATE human_tasks SET state = 'RESOLVED', resolved_at = datetime('now'), resolution_json = ?
     WHERE id = ? AND state = 'OPEN'`,
  ).run(JSON.stringify(resolution), id);
  logger.info({ taskId: id }, 'human task resolved');
}

export function expireTask(id: string, why: string): void {
  getDb().prepare(
    `UPDATE human_tasks SET state = 'EXPIRED', resolved_at = datetime('now'), resolution_json = ?
     WHERE id = ? AND state = 'OPEN'`,
  ).run(JSON.stringify({ why }), id);
}

export function openTasks(): Array<HumanTask & { createdAt: string }> {
  const rows = getDb().prepare(
    `SELECT id, application_id, kind, urgency, prompt, context_json, screenshot_path, created_at
     FROM human_tasks WHERE state = 'OPEN'
     ORDER BY CASE urgency WHEN 'URGENT' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END, created_at`,
  ).all() as Array<Record<string, string | null>>;
  return rows.map((r) => ({
    id: r['id']!,
    kind: r['kind'] as TaskKind,
    urgency: r['urgency'] as HumanTask['urgency'],
    prompt: r['prompt']!,
    createdAt: r['created_at']!,
    ...(r['application_id'] ? { applicationId: r['application_id'] } : {}),
    ...(r['screenshot_path'] ? { screenshotPath: r['screenshot_path'] } : {}),
    ...(r['context_json'] ? { context: JSON.parse(r['context_json']) as Record<string, unknown> } : {}),
  }));
}

/** Windows toast. Best-effort: a failed notification must never fail a run. */
function notifyWindows(title: string, body: string): void {
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode(${JSON.stringify(title)})) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode(${JSON.stringify(body)})) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Spani').Show(
  [Windows.UI.Notifications.ToastNotification]::new($t))`;
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], (e) => {
    if (e) logger.debug({ err: e.message }, 'toast notification failed');
  });
}

/** A banner in the page itself, so the instruction is where the person is looking. */
async function overlay(page: Page, text: string): Promise<void> {
  await page.evaluate((msg) => {
    document.getElementById('__spani_banner')?.remove();
    const el = document.createElement('div');
    el.id = '__spani_banner';
    el.textContent = `SPANI PAUSED — ${msg}`;
    el.setAttribute('style', [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'background:#b45309', 'color:#fff', 'font:600 14px/1.4 system-ui,sans-serif',
      'padding:12px 16px', 'text-align:center', 'box-shadow:0 2px 8px rgba(0,0,0,.3)',
    ].join(';'));
    document.body.appendChild(el);
  }, text).catch(() => { /* page may be mid-navigation */ });
}

async function clearOverlay(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('__spani_banner')?.remove()).catch(() => {});
}

export interface HandoffResult {
  handled: boolean;
  resumed: boolean;
  kind?: Verification['kind'];
  taskId?: string;
  waitedMs?: number;
  reason: string;
}

/**
 * Check for a verification gate and, if present, run the whole hand-over.
 *
 * Returns resumed=true when the agent should carry straight on. The caller
 * MUST re-snapshot before continuing: the page after a challenge is often not
 * the page before it.
 */
export async function handleVerification(
  page: Page,
  opts: { runId: string; applicationId?: string; timeoutMs?: number } = { runId: 'adhoc' },
): Promise<HandoffResult> {
  const v = await detectVerification(page);
  if (!v) return { handled: false, resumed: true, reason: 'no verification present' };

  const shot = await screenshot(page, opts.runId, `verify-${v.kind}`).catch(() => '');
  const taskId = openTask({
    kind: v.kind as TaskKind,
    urgency: 'URGENT',
    prompt: v.instruction,
    ...(opts.applicationId ? { applicationId: opts.applicationId } : {}),
    context: { evidence: v.evidence, url: page.url() },
    ...(shot ? { screenshotPath: shot } : {}),
  });

  await bringToFront(page);
  await overlay(page, v.instruction);
  notifyWindows('Spani needs you', v.instruction);

  // PAYMENT and anything else non-waitable stops here by design.
  if (v.clearedWhen === 'MANUAL') {
    return { handled: true, resumed: false, kind: v.kind, taskId, reason: v.instruction };
  }

  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const res = await waitForVerification(page, v, { timeoutMs });
  await clearOverlay(page);

  if (res.cleared) {
    resolveTask(taskId, { clearedBy: res.reason, waitedMs: res.waitedMs });
    logger.info({ kind: v.kind, waitedMs: res.waitedMs, reason: res.reason },
      'verification cleared - resuming automatically');
    return { handled: true, resumed: true, kind: v.kind, taskId, waitedMs: res.waitedMs, reason: res.reason };
  }

  expireTask(taskId, res.reason);
  return { handled: true, resumed: false, kind: v.kind, taskId, waitedMs: res.waitedMs, reason: res.reason };
}
