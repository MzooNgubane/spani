import fs from 'node:fs';
import YAML from 'yaml';
import { PATHS } from '../core/paths.js';
import { logger } from '../core/logger.js';
import { ProfileSchema, isSensitivePath, type Profile } from './schema.js';

export * from './schema.js';

export class ProfileError extends Error {}

let cached: Profile | null = null;

export function loadProfile(force = false): Profile {
  if (cached && !force) return cached;
  if (!fs.existsSync(PATHS.masterProfile)) {
    throw new ProfileError(`No master profile at ${PATHS.masterProfile}. Run: npm run spani init-profile`);
  }
  const parsed = ProfileSchema.safeParse(YAML.parse(fs.readFileSync(PATHS.masterProfile, 'utf8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ProfileError(`master.yaml failed validation:\n${issues}`);
  }
  cached = parsed.data;
  logger.debug({ verified: cached.meta.verified_by_human }, 'profile loaded');
  return cached;
}

/** Marker distinguishing "the profile says unknown" from "no such path". */
export const UNKNOWN = Symbol('UNKNOWN');
export type Resolved = string | number | boolean | typeof UNKNOWN;

/**
 * Resolve a dot-path against the profile.
 * Supports array indexing (`projects.0.name`) and returns UNKNOWN for null,
 * so callers must handle "the profile does not know" explicitly rather than
 * receiving an empty string and filling a form with it.
 */
/**
 * Values assembled from other fields.
 *
 * Forms ask for "Full name" far more often than they ask for a surname alone.
 * Without these the mapper escalates a field we can obviously answer, which
 * turns a solvable form into a human task for no reason.
 */
const DERIVED: Record<string, (p: Profile) => string | number | boolean | null> = {
  'personal.full_name': (p) => `${p.personal.first_name} ${p.personal.surname}`.trim(),
  'personal.initials': (p) => (p.personal.first_name[0] ?? '').toUpperCase(),
  'personal.address.term.full': (p) => {
    const a = p.personal.address.term;
    return a ? [a.line1, a.area, a.city, a.province, a.postal_code].filter(Boolean).join(', ') || null : null;
  },
  'personal.address.home.full': (p) => {
    const a = p.personal.address.home;
    return a ? [a.area, a.town, a.municipality, a.province, a.postal_code].filter(Boolean).join(', ') || null : null;
  },
  'education.current.institution_and_qualification': (p) =>
    `${p.education.current.qualification}, ${p.education.current.institution}`,
  /**
   * Forms ask this both ways round. Storing only the affirmative and letting
   * the mapper "invert" it invites the model to reason about negation, which
   * is exactly where a yes/no answer gets flipped on a funding declaration.
   */
  'funding.receives_other_bursary': (p) =>
    p.funding.declares_no_other_funding === null ? null : !p.funding.declares_no_other_funding,
  'funding.receives_nsfas': (p) => p.funding.nsfas.funded,
};

export const DERIVED_PATHS = Object.keys(DERIVED);

export function resolve(path: string, profile = loadProfile()): Resolved {
  const derive = DERIVED[path];
  if (derive) {
    const v = derive(profile);
    return v === null || v === '' ? UNKNOWN : v;
  }

  const parts = path.split('.');
  let node: unknown = profile;
  for (const part of parts) {
    if (node === null || node === undefined) return UNKNOWN;
    if (Array.isArray(node)) {
      const i = Number(part);
      if (!Number.isInteger(i)) return UNKNOWN;
      node = node[i];
    } else if (typeof node === 'object') {
      node = (node as Record<string, unknown>)[part];
    } else {
      return UNKNOWN;
    }
  }
  if (node === null || node === undefined || node === '') return UNKNOWN;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return node;
  return UNKNOWN;
}

export function isKnown(v: Resolved): v is string | number | boolean {
  return v !== UNKNOWN;
}

/** Every leaf dot-path, for building the AI prompt's allowed-path list. */
export function leafPaths(profile = loadProfile()): string[] {
  const out: string[] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== 'object') {
      if (prefix) out.push(prefix);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${prefix}.${i}`));
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
  };
  walk(profile, '');
  return out;
}

/**
 * The path list handed to Claude.
 *
 * Sensitive paths are INCLUDED (the model must be able to say "this field wants
 * the ID number") but their values never are. `meta.*` is excluded as noise.
 */
export function promptablePaths(profile = loadProfile()): Array<{ path: string; known: boolean; sensitive: boolean }> {
  return [...leafPaths(profile), ...DERIVED_PATHS]
    .filter((p) => !p.startsWith('meta.') && !p.startsWith('policy.'))
    .map((path) => ({
      path,
      known: isKnown(resolve(path, profile)),
      sensitive: isSensitivePath(path),
    }));
}

/** Paths flagged with `# ❓ NEEDS YOU`, i.e. required-ish fields still null. */
export function unknownPaths(profile = loadProfile()): string[] {
  return promptablePaths(profile).filter((p) => !p.known).map((p) => p.path);
}

export function assertSubmittable(profile = loadProfile()): void {
  if (!profile.meta.verified_by_human) {
    throw new ProfileError(
      'Profile is not human-verified (meta.verified_by_human: false). ' +
      'Review data/profile/master.yaml and set it to true before anything is submitted.',
    );
  }
}
