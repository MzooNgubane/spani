import type { Page } from 'playwright';
import { logger } from '../core/logger.js';

/**
 * Detects that a page is asking for a HUMAN, and detects when the human is done.
 *
 * We never attempt to solve, bypass, spoof or proxy around any of these. The
 * entire strategy is: notice quickly, hand over cleanly, take back immediately.
 * That last part is the point - one CAPTCHA in a twenty-step application should
 * cost ten seconds, not the other nineteen steps.
 */

export type VerificationKind =
  | 'CAPTCHA' | 'CLOUDFLARE' | 'OTP' | 'MFA' | 'EMAIL_VERIFY' | 'LOGIN_REQUIRED' | 'PAYMENT';

export interface Verification {
  kind: VerificationKind;
  /** What we matched on, so the log explains itself. */
  evidence: string;
  /** Shown to the user. Plain instruction, no jargon. */
  instruction: string;
  /** Re-evaluated by waitForVerification to know when to resume. */
  clearedWhen: 'ELEMENT_GONE' | 'NAVIGATION' | 'TOKEN_PRESENT' | 'MANUAL';
  selector?: string;
}

const CAPTCHA_FRAMES = [
  'google.com/recaptcha', 'recaptcha.net', 'hcaptcha.com',
  'challenges.cloudflare.com', 'turnstile',
];

const DETECTORS: Array<{
  kind: VerificationKind;
  instruction: string;
  clearedWhen: Verification['clearedWhen'];
  run: (page: Page) => Promise<string | null>;
}> = [
  {
    kind: 'CLOUDFLARE',
    instruction: 'Cloudflare is checking your browser. Tick the box if one appears, then leave the tab alone.',
    clearedWhen: 'NAVIGATION',
    run: async (page) => {
      const title = (await page.title().catch(() => '')).toLowerCase();
      if (/just a moment|attention required|checking your browser/.test(title)) return `title: ${title}`;
      const cf = await page.locator('#cf-challenge-running, .cf-browser-verification, #challenge-form')
        .first().isVisible().catch(() => false);
      return cf ? 'cloudflare challenge element' : null;
    },
  },
  {
    kind: 'CAPTCHA',
    instruction: 'Please solve the CAPTCHA in the browser window. I will carry on as soon as it passes.',
    clearedWhen: 'TOKEN_PRESENT',
    run: async (page) => {
      for (const f of page.frames()) {
        const url = f.url();
        if (CAPTCHA_FRAMES.some((p) => url.includes(p))) return `frame: ${new URL(url).host}`;
      }
      const el = page.locator('[data-sitekey], .g-recaptcha, .h-captcha, .cf-turnstile').first();
      if (await el.isVisible().catch(() => false)) return 'captcha widget';
      const text = page.getByText(/i'?m not a robot/i).first();
      return (await text.isVisible().catch(() => false)) ? '"I\'m not a robot" text' : null;
    },
  },
  {
    kind: 'OTP',
    instruction: 'A one-time code is required. Please enter it in the browser; I will continue automatically.',
    clearedWhen: 'ELEMENT_GONE',
    run: async (page) => {
      const el = page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i]').first();
      if (await el.isVisible().catch(() => false)) return 'one-time-code input';
      const t = page.getByText(/verification code|one[- ]time (pin|code)|enter the code we sent/i).first();
      return (await t.isVisible().catch(() => false)) ? 'OTP prompt text' : null;
    },
  },
  {
    kind: 'MFA',
    instruction: 'Multi-factor authentication is required. Please approve it, then leave the tab open.',
    clearedWhen: 'NAVIGATION',
    run: async (page) => {
      const t = page.getByText(/authenticator app|two[- ]factor|2fa|approve.*sign.?in|push notification/i).first();
      return (await t.isVisible().catch(() => false)) ? 'MFA prompt' : null;
    },
  },
  {
    kind: 'EMAIL_VERIFY',
    instruction: 'The site sent a verification email. Open the link in it; I will detect the change and continue.',
    clearedWhen: 'NAVIGATION',
    run: async (page) => {
      const t = page.getByText(/check your (inbox|email)|we'?ve sent (you )?an? (email|link)|verify your email/i).first();
      return (await t.isVisible().catch(() => false)) ? 'email verification prompt' : null;
    },
  },
  {
    kind: 'PAYMENT',
    instruction: 'This page is asking for payment details. Stopping - I will not enter payment information.',
    clearedWhen: 'MANUAL',
    run: async (page) => {
      const el = page.locator('input[autocomplete="cc-number"], input[name*="card" i][name*="number" i]').first();
      return (await el.isVisible().catch(() => false)) ? 'card number field' : null;
    },
  },
  {
    kind: 'LOGIN_REQUIRED',
    instruction: 'The site wants you signed in. Please log in; the session is saved for next time.',
    clearedWhen: 'NAVIGATION',
    run: async (page) => {
      const pw = page.locator('input[type="password"]').first();
      if (!(await pw.isVisible().catch(() => false))) return null;
      // A password field on a page that also has an application form is a
      // registration step, not a login wall.
      const many = await page.locator('input:not([type=hidden]), textarea, select').count();
      return many <= 6 ? 'password field on a short form' : null;
    },
  },
];

export async function detectVerification(page: Page): Promise<Verification | null> {
  for (const d of DETECTORS) {
    try {
      const evidence = await d.run(page);
      if (!evidence) continue;
      const v: Verification = {
        kind: d.kind, evidence, instruction: d.instruction, clearedWhen: d.clearedWhen,
      };
      logger.warn({ kind: v.kind, evidence, url: page.url() }, 'human verification detected');
      return v;
    } catch {
      // A detector throwing (navigation mid-check) is not a detection.
    }
  }
  return null;
}

export interface WaitResult {
  cleared: boolean;
  waitedMs: number;
  reason: string;
}

/**
 * Poll until the human is finished, then hand control back.
 *
 * Deliberately generous on what counts as "cleared": the exact signal differs
 * per site, so we accept any of them and then re-snapshot before continuing,
 * rather than assuming the page is where we left it.
 */
export async function waitForVerification(
  page: Page,
  v: Verification,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pollMs = opts.pollMs ?? 800;
  const startedAt = Date.now();
  const startUrl = page.url();

  if (v.clearedWhen === 'MANUAL') {
    return { cleared: false, waitedMs: 0, reason: 'requires a manual decision, not a wait' };
  }

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (page.isClosed()) return { cleared: false, waitedMs: Date.now() - startedAt, reason: 'page closed' };

    try {
      if (page.url() !== startUrl) {
        return { cleared: true, waitedMs: Date.now() - startedAt, reason: `navigated to ${page.url()}` };
      }
      if (v.clearedWhen === 'TOKEN_PRESENT') {
        const token = await page.evaluate(() => {
          const el = document.querySelector<HTMLTextAreaElement>(
            '[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]',
          );
          return el?.value ?? '';
        }).catch(() => '');
        if (token.length > 20) {
          return { cleared: true, waitedMs: Date.now() - startedAt, reason: 'challenge token present' };
        }
      }
      // Whatever the declared signal, the challenge simply being gone counts.
      if (!(await detectVerification(page))) {
        return { cleared: true, waitedMs: Date.now() - startedAt, reason: 'challenge no longer present' };
      }
    } catch {
      // Mid-navigation evaluate failures are expected; keep polling.
    }
  }

  return { cleared: false, waitedMs: Date.now() - startedAt, reason: 'timed out waiting for verification' };
}
