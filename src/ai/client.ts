import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { z } from 'zod';
import { loadConfig } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getDb } from '../core/db.js';

/**
 * Bridge to Claude via the Claude Code CLI in headless mode.
 *
 * WHY THE CLI AND NOT THE ANTHROPIC SDK:
 * The CLI authenticates with the user's Claude *subscription* (OAuth). The SDK
 * requires ANTHROPIC_API_KEY, which is separately metered and billed. Using the
 * CLI means reasoning costs draw against subscription rate limits, not a card.
 *
 * MEASURED OVERHEAD (2026-09-27, Haiku 4.5, this machine):
 *   default flags .......... 8,431 cache-create + 16,339 cache-read  $0.0190
 *   MCP + tools stripped ... 3,636 cache-create + 20,306 cache-read  $0.0096
 *   warm cache, repeat ..........  0 cache-create + 23,942 cache-read $0.0026
 * Hence: strip everything, and run as a sustained batch so the 1h prompt cache
 * stays warm. The flags below are not optional.
 */

export interface AiCallOptions {
  purpose: string;
  /** Overrides config.ai.models.cheap. On Pro, think hard before using a bigger model. */
  model?: string;
  runId?: string;
  applicationId?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface AiUsage {
  inputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface AiResult<T> {
  value: T;
  usage: AiUsage;
  raw: string;
}

export class AiError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'AiError';
  }
}

export class BudgetExceededError extends AiError {
  constructor(readonly spent: number, readonly cap: number, scope: string) {
    super(`Budget exceeded (${scope}): $${spent.toFixed(4)} of $${cap.toFixed(2)} notional`);
    this.name = 'BudgetExceededError';
  }
}

/** Resolve the claude executable. Prefers CLAUDE_CODE_EXECPATH, then npm global, then PATH. */
export function resolveCliPath(): string {
  const configured = loadConfig().ai.cliPath;
  if (configured && fs.existsSync(configured)) return configured;

  const fromEnv = process.env['CLAUDE_CODE_EXECPATH'];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules',
      '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'claude';
}

/**
 * Child env with API-key vars stripped.
 *
 * CRITICAL: if ANTHROPIC_API_KEY is present the CLI silently bills the API
 * instead of the subscription. That is the one failure mode that costs real
 * money, so we remove it unconditionally rather than trusting the environment.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  ]) delete env[k];
  return env;
}

interface CliEnvelope {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

function runCli(prompt: string, model: string, timeoutMs: number): Promise<CliEnvelope> {
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--model', model,
    // Strip the MCP + tool surface: ~5k tokens of prompt overhead we never use,
    // and it guarantees the reasoning layer cannot touch the filesystem or net.
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--allowedTools', '',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(resolveCliPath(), args, {
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AiError(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new AiError(`Failed to spawn Claude CLI: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new AiError(`Claude CLI exited ${code}`, stderr.slice(0, 2000)));
      try {
        resolve(JSON.parse(stdout) as CliEnvelope);
      } catch {
        reject(new AiError('Claude CLI returned non-JSON', stdout.slice(0, 2000)));
      }
    });
  });
}

/** Strip ```json fences and surrounding prose, then parse. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();

  try {
    return JSON.parse(body);
  } catch {
    // Model wrapped the JSON in prose: take the outermost brace/bracket span.
    const start = body.search(/[[{]/);
    if (start === -1) throw new AiError('No JSON found in model output', body.slice(0, 500));
    const open = body[start];
    const close = open === '[' ? ']' : '}';
    const end = body.lastIndexOf(close);
    if (end <= start) throw new AiError('Unbalanced JSON in model output', body.slice(0, 500));
    return JSON.parse(body.slice(start, end + 1));
  }
}

function recordCall(row: {
  purpose: string; model: string; runId?: string | undefined; applicationId?: string | undefined;
  usage?: AiUsage | undefined; ok: boolean; error?: string | undefined;
}): void {
  getDb().prepare(`
    INSERT INTO ai_calls (id, run_id, application_id, purpose, model, input_tokens,
      cache_create_tokens, cache_read_tokens, output_tokens, cost_usd, duration_ms, ok, error_text)
    VALUES (@id, @runId, @applicationId, @purpose, @model, @inputTokens,
      @cacheCreate, @cacheRead, @outputTokens, @costUsd, @durationMs, @ok, @error)
  `).run({
    id: randomUUID(),
    runId: row.runId ?? null,
    applicationId: row.applicationId ?? null,
    purpose: row.purpose,
    model: row.model,
    inputTokens: row.usage?.inputTokens ?? null,
    cacheCreate: row.usage?.cacheCreateTokens ?? null,
    cacheRead: row.usage?.cacheReadTokens ?? null,
    outputTokens: row.usage?.outputTokens ?? null,
    costUsd: row.usage?.costUsd ?? 0,
    durationMs: row.usage?.durationMs ?? null,
    ok: row.ok ? 1 : 0,
    error: row.error ?? null,
  });
}

/** Notional spend in the last 24h, across all runs. */
export function spentLast24h(): number {
  const r = getDb().prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_calls WHERE created_at > datetime('now','-1 day')`,
  ).get() as { total: number };
  return r.total;
}

export function spentInRun(runId: string): number {
  const r = getDb().prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_calls WHERE run_id = ?',
  ).get(runId) as { total: number };
  return r.total;
}

function assertBudget(runId?: string): void {
  const { budget } = loadConfig();
  const day = spentLast24h();
  if (day >= budget.perDayUsd) throw new BudgetExceededError(day, budget.perDayUsd, '24h');
  if (runId) {
    const run = spentInRun(runId);
    if (run >= budget.perRunUsd) throw new BudgetExceededError(run, budget.perRunUsd, 'run');
  }
}

/**
 * Ask Claude for a JSON value matching `schema`.
 *
 * The schema is the contract: a response that does not validate is retried with
 * the validation error appended, then fails hard. Nothing unvalidated ever
 * reaches the browser layer.
 */
export async function askJson<T>(
  prompt: string,
  // Input pinned to `unknown` so T binds to the schema's OUTPUT type. With a
  // plain z.ZodType<T>, a schema using .default() infers T from its input side
  // and every defaulted field arrives as possibly-undefined.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  opts: AiCallOptions,
): Promise<AiResult<T>> {
  const cfg = loadConfig();
  const model = opts.model ?? cfg.ai.models.cheap;
  const timeoutMs = opts.timeoutMs ?? cfg.ai.timeoutMs;
  const maxRetries = opts.maxRetries ?? cfg.ai.maxRetries;

  assertBudget(opts.runId);

  let attemptPrompt = prompt;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const env = await runCli(attemptPrompt, model, timeoutMs);
      const usage: AiUsage = {
        inputTokens: env.usage?.input_tokens ?? 0,
        cacheCreateTokens: env.usage?.cache_creation_input_tokens ?? 0,
        cacheReadTokens: env.usage?.cache_read_input_tokens ?? 0,
        outputTokens: env.usage?.output_tokens ?? 0,
        costUsd: env.total_cost_usd ?? 0,
        durationMs: env.duration_ms ?? 0,
      };

      if (env.is_error || typeof env.result !== 'string') {
        recordCall({ ...opts, model, usage, ok: false, error: env.subtype ?? 'cli_error' });
        throw new AiError(`Claude returned an error envelope (${env.subtype ?? 'unknown'})`);
      }

      const parsed = schema.safeParse(extractJson(env.result));
      recordCall({ ...opts, model, usage, ok: parsed.success, error: parsed.success ? undefined : 'schema_mismatch' });

      logger.debug(
        { purpose: opts.purpose, model, attempt, cost: usage.costUsd, ms: usage.durationMs, ok: parsed.success },
        'ai call',
      );

      if (parsed.success) return { value: parsed.data, usage, raw: env.result };

      lastErr = parsed.error;
      attemptPrompt =
        `${prompt}\n\n--- YOUR PREVIOUS REPLY FAILED VALIDATION ---\n` +
        `${JSON.stringify(parsed.error.issues.slice(0, 8))}\n` +
        `Return ONLY valid JSON matching the required shape. No prose, no code fences.`;
    } catch (e) {
      if (e instanceof BudgetExceededError) throw e;
      lastErr = e;
      recordCall({ ...opts, model, ok: false, error: e instanceof Error ? e.message : String(e) });
      if (attempt === maxRetries) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }

  throw new AiError(`askJson failed after ${maxRetries + 1} attempts (${opts.purpose})`, lastErr);
}

export function promptHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}
