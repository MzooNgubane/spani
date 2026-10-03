import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../core/db.js';
import { logger } from '../core/logger.js';
import { loadConfig } from '../core/config.js';
import { loadProfile, unknownPaths, isBlockingPath } from '../profile/index.js';
import { loadManifest } from '../documents/index.js';
import { openTasks, resolveTask } from '../hitl/broker.js';
import { spentLast24h } from '../ai/client.js';

/**
 * Local dashboard. node:http rather than Express - the whole surface is six
 * routes and one SSE stream, and a dependency-free server is one less thing
 * to keep patched on a machine holding ID documents.
 *
 * Binds to 127.0.0.1 only. Never expose this.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export interface DashboardState {
  counts: Record<string, number>;
  opportunities: number;
  documents: { total: number; verified: number };
  profile: { name: string; verified: boolean; blocking: number };
  budget: { spent24h: number; cap: number };
  tasks: ReturnType<typeof openTasks>;
  awaitingApproval: Array<{
    id: string; title: string; organisation: string | null; closingDate: string | null;
    riskTier: string; preparedAt: string | null; urgent: boolean; fields: number;
  }>;
  recentLog: Array<{ ts: string; level: string; event: string }>;
}

function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const d = new Date(date).getTime();
  return Number.isNaN(d) ? null : Math.ceil((d - Date.now()) / 86_400_000);
}

export function readState(): DashboardState {
  const db = getDb();
  const cfg = loadConfig();

  const counts: Record<string, number> = {};
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM applications GROUP BY status')
    .all() as Array<{ status: string; n: number }>) counts[r.status] = r.n;

  const opportunities = (db.prepare('SELECT COUNT(*) n FROM opportunities').get() as { n: number }).n;
  const docs = db.prepare(
    'SELECT COUNT(*) total, SUM(verified_by_human) verified FROM documents',
  ).get() as { total: number; verified: number | null };

  let profile = { name: 'not loaded', verified: false, blocking: 0 };
  try {
    const p = loadProfile();
    profile = {
      name: `${p.personal.first_name} ${p.personal.surname}`,
      verified: p.meta.verified_by_human,
      blocking: unknownPaths(p).filter(isBlockingPath).length,
    };
  } catch { /* profile not ready yet */ }

  const awaiting = (db.prepare(`
    SELECT a.id, a.risk_tier, a.replay_prepared_at, o.title, o.organisation, o.closing_date,
           (SELECT COUNT(*) FROM field_fills f WHERE f.application_id = a.id) AS fields
    FROM applications a JOIN opportunities o ON o.id = a.opportunity_id
    WHERE a.status = 'AWAITING_APPROVAL' ORDER BY o.closing_date IS NULL, o.closing_date
  `).all() as Array<Record<string, string | number | null>>).map((r) => {
    const closing = (r['closing_date'] as string | null) ?? null;
    const d = daysUntil(closing);
    return {
      id: r['id'] as string,
      title: r['title'] as string,
      organisation: (r['organisation'] as string | null) ?? null,
      closingDate: closing,
      riskTier: r['risk_tier'] as string,
      preparedAt: (r['replay_prepared_at'] as string | null) ?? null,
      urgent: d !== null && d <= cfg.policy.urgentWithinDays,
      fields: Number(r['fields'] ?? 0),
    };
  });

  const recentLog = db.prepare(
    'SELECT ts, level, event FROM log_events ORDER BY id DESC LIMIT 40',
  ).all() as Array<{ ts: string; level: string; event: string }>;

  return {
    counts, opportunities,
    documents: { total: docs.total, verified: docs.verified ?? 0 },
    profile,
    budget: { spent24h: spentLast24h(), cap: cfg.budget.perDayUsd },
    tasks: openTasks(),
    awaitingApproval: awaiting,
    recentLog,
  };
}

const sseClients = new Set<http.ServerResponse>();

/** Push a fresh state to every open dashboard. */
export function broadcast(): void {
  if (!sseClients.size) return;
  const payload = `data: ${JSON.stringify(readState())}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
  catch { return {}; }
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === 'GET /') {
        const html = fs.readFileSync(path.join(here, 'static', 'index.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (route === 'GET /api/state') { json(res, 200, readState()); return; }

      if (route === 'GET /api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(readState())}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
        return;
      }

      // Screenshots are on disk outside the web root; serve them explicitly
      // and only from the artifacts directory.
      if (route === 'GET /api/shot') {
        const { PATHS } = await import('../core/paths.js');
        const p = path.resolve(url.searchParams.get('p') ?? '');
        if (!p.startsWith(path.resolve(PATHS.artifacts)) || !fs.existsSync(p)) {
          json(res, 404, { error: 'not found' }); return;
        }
        res.writeHead(200, { 'content-type': 'image/png' });
        fs.createReadStream(p).pipe(res);
        return;
      }

      const taskResolve = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/resolve$/);
      if (req.method === 'POST' && taskResolve) {
        resolveTask(taskResolve[1]!, await readBody(req));
        broadcast();
        json(res, 200, { ok: true });
        return;
      }

      if (route === 'GET /api/review') {
        const m = loadManifest();
        const p = loadProfile();
        json(res, 200, {
          blockingPaths: unknownPaths(p).filter(isBlockingPath),
          documentQuestions: m.documents
            .filter((d) => d.open_question)
            .map((d) => ({ key: d.key, file: d.file, question: d.open_question })),
          encrypted: m.documents.filter((d) => d.encrypted).map((d) => d.file),
          thirdParty: m.documents.filter((d) => d.third_party).length,
        });
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (e) {
      logger.error({ route, err: e instanceof Error ? e.message : String(e) }, 'dashboard error');
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

export function startServer(port = 4317): Promise<http.Server> {
  const server = createServer();
  return new Promise((resolve) => {
    // 127.0.0.1 only. This process can read your ID documents.
    server.listen(port, '127.0.0.1', () => {
      logger.info({ url: `http://127.0.0.1:${port}` }, 'dashboard listening');
      resolve(server);
    });
  });
}
