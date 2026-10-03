import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { z } from 'zod';
import { PATHS } from '../core/paths.js';
import { logger } from '../core/logger.js';
import { getDb } from '../core/db.js';

export const DocEntrySchema = z.object({
  key: z.string(),
  type: z.string(),
  file: z.string(),
  description: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  organisation: z.string().optional(),
  certified: z.boolean().nullable().default(null),
  third_party: z.boolean().default(false),
  sensitivity: z.enum(['NORMAL', 'HIGH']).default('NORMAL'),
  never_auto_upload: z.boolean().default(false),
  encrypted: z.boolean().default(false),
  is_primary_cv: z.boolean().default(false),
  reuse_as_template: z.boolean().default(false),
  /** CANDIDATE = one of several files claiming the same role; not selectable yet. */
  status: z.enum(['ACTIVE', 'CANDIDATE', 'ARCHIVED']).default('ACTIVE'),
  valid_from: z.string().optional(),
  valid_until: z.string().optional(),
  source_file: z.string().optional(),
  duplicates: z.array(z.string()).default([]),
  open_question: z.string().optional(),
  /** Nothing is uploadable until you set this true. */
  verified: z.boolean().default(false),
});

export const ManifestSchema = z.object({
  source_dir: z.string(),
  documents: z.array(DocEntrySchema),
  ignore: z.array(z.string()).default([]),
});

export type DocEntry = z.infer<typeof DocEntrySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export class DocumentError extends Error {}

export function loadManifest(): Manifest {
  if (!fs.existsSync(PATHS.manifest)) {
    throw new DocumentError(`No manifest at ${PATHS.manifest}`);
  }
  const parsed = ManifestSchema.safeParse(YAML.parse(fs.readFileSync(PATHS.manifest, 'utf8')));
  if (!parsed.success) {
    throw new DocumentError(
      `manifest.yaml failed validation:\n` +
      parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }
  const keys = new Set<string>();
  for (const d of parsed.data.documents) {
    if (keys.has(d.key)) throw new DocumentError(`Duplicate document key: ${d.key}`);
    keys.add(d.key);
  }
  return parsed.data;
}

export function absPath(m: Manifest, entry: DocEntry): string {
  return path.join(m.source_dir, entry.file);
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export interface IngestReport {
  inserted: number;
  updated: number;
  missing: string[];
  unlisted: string[];
}

/** Sync the manifest into the documents table, hashing every file on disk. */
export function ingest(): IngestReport {
  const m = loadManifest();
  const db = getDb();
  const report: IngestReport = { inserted: 0, updated: 0, missing: [], unlisted: [] };

  const upsert = db.prepare(`
    INSERT INTO documents (id, doc_key, type, path, sha256, size_bytes, description,
      aliases_json, applies_to_json, certified, third_party, sensitivity, version,
      valid_from, valid_until, verified_by_human)
    VALUES (@id, @key, @type, @path, @sha256, @size, @description,
      @aliases, @appliesTo, @certified, @thirdParty, @sensitivity, 1,
      @validFrom, @validUntil, @verified)
    ON CONFLICT(doc_key) DO UPDATE SET
      type = @type, path = @path, sha256 = @sha256, size_bytes = @size,
      description = @description, aliases_json = @aliases, certified = @certified,
      third_party = @thirdParty, sensitivity = @sensitivity,
      valid_from = @validFrom, valid_until = @validUntil, verified_by_human = @verified
  `);

  const run = db.transaction(() => {
    for (const d of m.documents) {
      const p = absPath(m, d);
      if (!fs.existsSync(p)) { report.missing.push(d.file); continue; }
      const stat = fs.statSync(p);
      const existed = db.prepare('SELECT 1 FROM documents WHERE doc_key = ?').get(d.key);
      upsert.run({
        id: randomUUID(),
        key: d.key,
        type: d.type,
        path: p,
        sha256: sha256(p),
        size: stat.size,
        description: d.description ?? null,
        aliases: JSON.stringify(d.aliases),
        appliesTo: JSON.stringify({
          status: d.status,
          neverAutoUpload: d.never_auto_upload,
          encrypted: d.encrypted,
          isPrimaryCv: d.is_primary_cv,
          reuseAsTemplate: d.reuse_as_template,
          organisation: d.organisation ?? null,
          openQuestion: d.open_question ?? null,
        }),
        certified: d.certified === null ? null : d.certified ? 1 : 0,
        thirdParty: d.third_party ? 1 : 0,
        sensitivity: d.sensitivity,
        validFrom: d.valid_from ?? null,
        validUntil: d.valid_until ?? null,
        verified: d.verified ? 1 : 0,
      });
      existed ? report.updated++ : report.inserted++;
    }
  });
  run();

  // Anything on disk the manifest does not account for is a silent gap.
  if (fs.existsSync(m.source_dir)) {
    const listed = new Set([
      ...m.documents.map((d) => d.file),
      ...m.documents.flatMap((d) => d.duplicates),
      ...m.documents.flatMap((d) => (d.source_file ? [d.source_file] : [])),
      ...m.ignore,
    ]);
    // Walk subdirectories too, since documents are organised by category.
    const walk = (dir: string, prefix = ''): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? path.join(prefix, e.name) : e.name;
        if (e.isDirectory()) { walk(path.join(dir, e.name), rel); continue; }
        if (rel === 'manifest.yaml') continue;   // the manifest is not a document
        if (!listed.has(rel)) report.unlisted.push(rel);
      }
    };
    walk(m.source_dir);
  }

  logger.info(report, 'document ingest complete');
  return report;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(s: string): string[] {
  const t = normalise(s);
  return t ? t.split(' ') : [];
}

/**
 * Whether `needle`'s tokens appear as a contiguous run inside `hay`'s tokens.
 *
 * Token-level, NOT substring: plain `includes` made the alias "nsc" match
 * "tra-nsc-ript", tying the matric certificate with the academic transcript.
 * Uploading the wrong one of those is a silently rejected application.
 */
function containsPhrase(hay: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export interface MatchResult {
  entry: DocEntry;
  score: number;
  reason: string;
}

export interface MatchOutcome {
  best: MatchResult | null;
  candidates: MatchResult[];
  /** Set when the agent must stop and ask rather than guess. */
  blocked: string | null;
}

/**
 * Match an upload field's label to a document. Deterministic, zero AI calls.
 *
 * Refuses rather than guesses when: nothing scores, several tie, the file is
 * unverified, expired, encrypted, or flagged never_auto_upload.
 */
export function matchDocument(
  label: string,
  opts: { today?: Date; manifest?: Manifest } = {},
): MatchOutcome {
  const m = opts.manifest ?? loadManifest();
  const q = normalise(label);
  const qt = tokens(label);
  const today = opts.today ?? new Date();
  const results: MatchResult[] = [];

  for (const d of m.documents) {
    if (d.status !== 'ACTIVE') continue;
    let score = 0;
    let reason = '';

    for (const alias of d.aliases) {
      const at = tokens(alias);
      if (!at.length) continue;
      if (q === at.join(' ')) { score = Math.max(score, 1.0); reason = `exact alias "${alias}"`; }
      else if (containsPhrase(qt, at)) {
        // Longer alias matches are more specific, so rank them higher.
        const s = 0.8 + Math.min(0.14, at.length * 0.02);
        if (s > score) { score = s; reason = `label contains "${alias}"`; }
      } else if (containsPhrase(at, qt) && qt.length > 1) {
        if (0.6 > score) { score = 0.6; reason = `alias "${alias}" contains label`; }
      }
    }
    if (containsPhrase(qt, tokens(d.type))) {
      if (0.5 > score) { score = 0.5; reason = `type ${d.type}`; }
    }
    // "certified copy of ID" must not resolve to the uncertified file.
    const wantsCertified = qt.includes('certified');
    if (wantsCertified && d.certified === false) score *= 0.3;
    if (wantsCertified && d.certified === true) score = Math.min(1, score + 0.1);

    if (score > 0) results.push({ entry: d, score, reason });
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0] ?? null;

  if (!best) return { best: null, candidates: [], blocked: `No document matches "${label}"` };

  const second = results[1];
  if (second && best.score - second.score < 0.1) {
    return {
      best: null,
      candidates: results.slice(0, 4),
      blocked: `Ambiguous: "${label}" matches ${results.slice(0, 3).map((r) => r.entry.key).join(', ')} equally`,
    };
  }
  if (!best.entry.verified) {
    return { best: null, candidates: results.slice(0, 4), blocked: `"${best.entry.key}" is not human-verified` };
  }
  if (best.entry.never_auto_upload) {
    return { best: null, candidates: [best], blocked: `"${best.entry.key}" requires explicit approval (third-party or sensitive)` };
  }
  if (best.entry.encrypted) {
    return { best: null, candidates: [best], blocked: `"${best.entry.key}" is password-protected and cannot be uploaded` };
  }
  if (best.entry.valid_until && new Date(best.entry.valid_until) < today) {
    return { best: null, candidates: [best], blocked: `"${best.entry.key}" expired on ${best.entry.valid_until}` };
  }

  return { best, candidates: results.slice(0, 4), blocked: null };
}
