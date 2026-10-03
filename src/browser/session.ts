import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { PATHS, artifactDir } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { logger } from '../core/logger.js';

/**
 * A single, long-lived, HEADED Chrome session backed by a persistent profile.
 *
 * WHY HEADED AND WHY A REAL CHROME PROFILE:
 *  - Logins, cookies and portal sessions must survive between nightly runs.
 *    A fresh context would mean re-authenticating (and re-verifying by email)
 *    on every application.
 *  - Headless Chrome is trivially fingerprinted and gets challenged far more.
 *    We do not spoof anything, so the only honest way to reduce challenges is
 *    to actually be a real browser.
 *  - You must be able to SEE the window to solve a CAPTCHA when we pause.
 *
 * WHY ONE AT A TIME: 8 GB of RAM. Parallel contexts swap and time out.
 */

let ctx: BrowserContext | null = null;

export interface SessionOptions {
  /** Separate profile dir, e.g. per-site login isolation. Defaults to the shared one. */
  profileDir?: string;
  runId?: string;
}

export async function openSession(opts: SessionOptions = {}): Promise<BrowserContext> {
  if (ctx) return ctx;
  const cfg = loadConfig();
  const dir = opts.profileDir ?? PATHS.browserProfile;
  fs.mkdirSync(dir, { recursive: true });

  ctx = await chromium.launchPersistentContext(dir, {
    channel: cfg.browser.channel,
    headless: false,
    slowMo: cfg.browser.slowMoMs,
    viewport: { width: 1366, height: 900 },
    locale: 'en-ZA',
    timezoneId: 'Africa/Johannesburg',
    acceptDownloads: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      '--disable-background-timer-throttling',
    ],
  });

  ctx.setDefaultNavigationTimeout(cfg.browser.navTimeoutMs);
  ctx.setDefaultTimeout(15_000);

  ctx.on('page', (p) => {
    p.on('console', (m) => {
      if (m.type() === 'error') logger.debug({ url: p.url(), msg: m.text().slice(0, 300) }, 'page console error');
    });
    p.on('pageerror', (e) => logger.debug({ url: p.url(), err: e.message.slice(0, 300) }, 'page error'));
  });

  logger.info({ dir, channel: cfg.browser.channel }, 'browser session open');
  return ctx;
}

export async function newPage(): Promise<Page> {
  const c = await openSession();
  const pages = c.pages();
  // launchPersistentContext always yields one blank page: reuse it.
  const blank = pages.find((p) => p.url() === 'about:blank');
  return blank ?? c.newPage();
}

export async function closeSession(): Promise<void> {
  await ctx?.close();
  ctx = null;
  logger.info('browser session closed');
}

/** Raise the window so the person can actually see what we are asking for. */
export async function bringToFront(page: Page): Promise<void> {
  try {
    await page.bringToFront();
  } catch (e) {
    logger.warn({ err: String(e) }, 'bringToFront failed');
  }
}

export async function screenshot(page: Page, runId: string, name: string): Promise<string> {
  const dir = artifactDir(runId);
  const file = path.join(dir, `${Date.now()}-${name.replace(/[^a-z0-9-]/gi, '_')}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/** Human-ish pacing. Not evasion - just not hammering someone's server. */
export function jitter(baseMs = 400): Promise<void> {
  return new Promise((r) => setTimeout(r, baseMs + Math.random() * baseMs));
}
