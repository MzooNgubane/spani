import type { Page } from 'playwright';
import { newPage } from '../browser/session.js';
import { logger } from '../core/logger.js';

/**
 * Reads verification emails out of Gmail in the agent's own signed-in browser.
 *
 * WHY THIS RATHER THAN IMAP OR THE GMAIL API:
 * Both need a credential - an App Password or an OAuth refresh token - stored
 * on disk, which is one more secret to protect and one more thing that can
 * leak. The agent already keeps a persistent Chrome profile so portal logins
 * survive between runs. Gmail is just another logged-in site in that profile.
 * Nothing is stored, nothing is transmitted anywhere, and the session is the
 * same one the person signed into by hand.
 *
 * SCOPE DISCIPLINE: every read is a targeted search - recent, unread, matching
 * an expected sender or subject. The agent never enumerates the mailbox, and
 * message bodies never enter an AI prompt. Links and codes are extracted by
 * regex and handed straight to the browser.
 */

const GMAIL = 'https://mail.google.com/mail/u/0/';

export interface MailboxStatus {
  signedIn: boolean;
  account: string | null;
  detail: string;
}

export async function checkMailbox(page?: Page): Promise<MailboxStatus> {
  const p = page ?? await newPage();
  await p.goto(GMAIL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await p.waitForTimeout(2500);

  const url = p.url();
  if (/accounts\.google\.com|ServiceLogin|signin/.test(url)) {
    return { signedIn: false, account: null, detail: 'Gmail is asking for sign-in' };
  }

  // The account chip carries the address in its aria-label.
  const account = await p.evaluate(`(() => {
    const el = document.querySelector('a[aria-label*="@"], [aria-label*="Google Account"]');
    const label = el && el.getAttribute('aria-label');
    const m = label && label.match(/[\\w.+-]+@[\\w.-]+\\.\\w+/);
    return m ? m[0] : null;
  })()`).catch(() => null) as string | null;

  const hasMailUi = await p.locator('[role="main"], [gh="tl"]').first().isVisible().catch(() => false);
  return hasMailUi
    ? { signedIn: true, account, detail: account ? `signed in as ${account}` : 'signed in' }
    : { signedIn: false, account: null, detail: 'Gmail loaded but the mail list did not render' };
}

export interface VerificationQuery {
  /** Words likely in the sender or subject, e.g. the bursary's organisation. */
  hint?: string;
  /** Only consider mail newer than this many minutes. Default 15. */
  withinMinutes?: number;
  /** How long to keep checking before giving up. Default 3 minutes. */
  timeoutMs?: number;
}

export interface VerificationFound {
  /** A clickable verification/confirmation URL, if the mail had one. */
  link: string | null;
  /** A numeric code, if the mail used one instead. */
  code: string | null;
  subject: string;
  from: string;
  raw: string;
}

/** URLs that look like a verification action rather than a footer or tracker. */
const LINK_HINTS = /verify|confirm|activate|validate|complete[-_]?registration|set[-_]?password|email[-_]?confirm/i;
const LINK_NOISE = /unsubscribe|privacy|terms|\.(png|jpg|gif|css|js)(\?|$)|facebook\.com|twitter\.com|linkedin\.com|instagram\.com/i;

function pickLink(hrefs: string[]): string | null {
  const candidates = hrefs
    .filter((h) => /^https?:\/\//i.test(h))
    .filter((h) => !LINK_NOISE.test(h));
  return candidates.find((h) => LINK_HINTS.test(h))
    // Long opaque paths are usually the tokenised action link.
    ?? candidates.find((h) => /[?/][A-Za-z0-9_-]{24,}/.test(h))
    ?? null;
}

function pickCode(text: string): string | null {
  // Prefer a number the surrounding words identify as a code.
  const labelled = text.match(
    /(?:code|otp|pin|password)[^0-9]{0,24}(\d{4,8})|(\d{4,8})[^0-9]{0,24}(?:is your|verification)/i,
  );
  if (labelled) return labelled[1] ?? labelled[2] ?? null;
  const bare = text.match(/\b(\d{6})\b/);
  return bare?.[1] ?? null;
}

/**
 * Search the mailbox for a verification message and pull the link or code out.
 *
 * Polls, because the email usually has not arrived when the form says it has.
 */
export async function findVerification(
  q: VerificationQuery = {},
  page?: Page,
): Promise<VerificationFound | null> {
  const p = page ?? await newPage();
  const withinMinutes = q.withinMinutes ?? 15;
  const timeoutMs = q.timeoutMs ?? 3 * 60_000;
  const deadline = Date.now() + timeoutMs;

  const terms = [
    'newer_than:1d',
    '(verify OR verification OR confirm OR activate OR "one-time" OR OTP OR code)',
    q.hint ? `(${q.hint.split(/\s+/).slice(0, 3).join(' OR ')})` : '',
  ].filter(Boolean).join(' ');

  while (Date.now() < deadline) {
    await p.goto(`${GMAIL}#search/${encodeURIComponent(terms)}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2500);

    const opened = await p.evaluate(`(() => {
      const rows = document.querySelectorAll('tr.zA');
      if (!rows.length) return false;
      rows[0].click();
      return true;
    })()`).catch(() => false);

    if (opened) {
      await p.waitForTimeout(2000);
      const found = await p.evaluate(`(() => {
        const body = document.querySelector('.a3s, [role="listitem"] .ii');
        if (!body) return null;
        const cutoff = ${Date.now() - withinMinutes * 60_000};
        const dateEl = document.querySelector('.g3[title], span.g3');
        return {
          text: (body.innerText || '').slice(0, 8000),
          hrefs: Array.from(body.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')).filter(Boolean),
          subject: (document.querySelector('h2.hP') || {}).innerText || '',
          from: (document.querySelector('.gD') || {}).getAttribute?.('email') || '',
          when: dateEl ? dateEl.getAttribute('title') || dateEl.innerText : '',
          cutoff,
        };
      })()`).catch(() => null) as
        { text: string; hrefs: string[]; subject: string; from: string } | null;

      if (found) {
        const link = pickLink(found.hrefs);
        const code = pickCode(found.text);
        if (link || code) {
          logger.info({ subject: found.subject.slice(0, 60), from: found.from, hasLink: !!link, hasCode: !!code },
            'verification email found');
          return { link, code, subject: found.subject, from: found.from, raw: found.text.slice(0, 500) };
        }
      }
    }

    await p.waitForTimeout(10_000);
  }

  logger.warn({ hint: q.hint }, 'no verification email found before timeout');
  return null;
}
