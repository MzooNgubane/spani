import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PATHS } from './paths.js';

/**
 * Tuned for Claude Pro ($20/mo) on a 4-core / 8GB machine.
 * Costs are NOTIONAL list-price equivalents reported by the Claude CLI; on a
 * subscription they are a proxy for rate-limit consumption, not money owed.
 */
export const ConfigSchema = z.object({
  ai: z.object({
    cliPath: z.string().optional(),
    models: z.object({
      /** Snapshot mapping, eligibility, classification. Everything, basically. */
      cheap: z.string().default('claude-haiku-4-5-20251001'),
      /** Reserved. NOT used by the unattended agent on Pro - see docs/cost.md */
      writer: z.string().default('claude-haiku-4-5-20251001'),
    }).default({}),
    timeoutMs: z.number().int().positive().default(120_000),
    maxRetries: z.number().int().min(0).default(2),
  }).default({}),

  budget: z.object({
    /** Hard stop for a single run, in notional USD. */
    perRunUsd: z.number().positive().default(1.00),
    /** Rolling 24h ceiling. */
    perDayUsd: z.number().positive().default(1.50),
    /** Warn into the digest above this fraction of the cap. */
    warnAt: z.number().min(0).max(1).default(0.8),
  }).default({}),

  browser: z.object({
    channel: z.enum(['chrome', 'chromium', 'msedge']).default('chrome'),
    headless: z.literal(false).default(false),
    /** 8GB RAM: one context at a time, no exceptions. */
    concurrency: z.literal(1).default(1),
    navTimeoutMs: z.number().int().positive().default(45_000),
    slowMoMs: z.number().int().min(0).default(120),
  }).default({}),

  policy: z.object({
    /** Global kill-switch. Nothing is submitted while false. */
    submitEnabled: z.boolean().default(false),
    /** Successful, human-approved submissions before a site may reach GREEN. */
    greenAfterSuccesses: z.number().int().min(1).default(3),
    /** Flag AMBER items as URGENT in the digest within N days of closing. */
    urgentWithinDays: z.number().int().min(0).default(5),
    /** Discovery-only. Never drive an application on these hosts. */
    discoveryOnlyHosts: z.array(z.string()).default([
      'linkedin.com', 'www.linkedin.com',
      'indeed.com', 'za.indeed.com', 'www.indeed.com',
    ]),
  }).default({}),

  log: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const file = path.join(PATHS.root, 'spani.config.json');
  const raw = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : {};
  cached = ConfigSchema.parse(raw);
  return cached;
}
