import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchDocument, ManifestSchema, type Manifest } from '../src/documents/index.js';

/** A verified, unambiguous fixture manifest - the shape the real one will have
 *  once the review sitting is done. */
const manifest: Manifest = ManifestSchema.parse({
  source_dir: 'C:\\fixtures',
  documents: [
    { key: 'cv', type: 'CV', file: 'cv.pdf', verified: true,
      aliases: ['cv', 'curriculum vitae', 'resume'] },
    { key: 'transcript', type: 'ACADEMIC_TRANSCRIPT', file: 'transcript.pdf', verified: true,
      aliases: ['academic transcript', 'academic record', 'statement of results'] },
    { key: 'matric', type: 'MATRIC_CERTIFICATE', file: 'matric.pdf', verified: true, certified: true,
      aliases: ['matric certificate', 'nsc', 'national senior certificate', 'grade 12 results'] },
    { key: 'id_certified', type: 'ID_CERTIFIED', file: 'id_cert.pdf', verified: true, certified: true,
      aliases: ['certified id', 'certified copy of id', 'identity document'] },
    { key: 'id_plain', type: 'ID', file: 'id.pdf', verified: true, certified: false,
      aliases: ['id copy', 'copy of id', 'identity document'] },
    { key: 'residence', type: 'PROOF_OF_RESIDENCE', file: 'por.pdf', verified: true,
      aliases: ['proof of residence', 'proof of address'],
      valid_from: '2026-09-09', valid_until: '2026-12-09' },
    { key: 'parent_bank', type: 'PARENT_BANK_STATEMENT', file: 'pbs.pdf', verified: true,
      third_party: true, never_auto_upload: true, aliases: ['parents bank statement'] },
    { key: 'locked', type: 'ACCEPTANCE_LETTER', file: 'locked.pdf', verified: true,
      encrypted: true, aliases: ['acceptance letter'] },
    { key: 'unverified_cv', type: 'CV', file: 'cv2.pdf', verified: false, status: 'CANDIDATE',
      aliases: ['cv'] },
  ],
});

const on = (label: string, today = new Date('2026-10-01')) =>
  matchDocument(label, { manifest, today });

describe('document matcher', () => {
  test('matches an exact alias', () => {
    assert.equal(on('CV').best?.entry.key, 'cv');
  });

  test('matches an alias embedded in a sentence', () => {
    assert.equal(on('Upload your academic transcript').best?.entry.key, 'transcript');
  });

  // Regression: substring matching made the alias "nsc" hit "tra-NSC-ript",
  // tying the matric certificate with the transcript. Token boundaries fix it.
  test('does not match "nsc" inside "transcript"', () => {
    const r = on('Upload your academic transcript');
    assert.equal(r.blocked, null);
    assert.equal(r.candidates.find((c) => c.entry.key === 'matric'), undefined);
  });

  test('prefers the certified file when the label says certified', () => {
    assert.equal(on('Please attach a certified copy of ID').best?.entry.key, 'id_certified');
  });

  test('prefers the plain file when the label does not say certified', () => {
    assert.equal(on('Upload id copy').best?.entry.key, 'id_plain');
  });

  test('refuses rather than guessing when nothing matches', () => {
    const r = on('Upload your pilot licence');
    assert.equal(r.best, null);
    assert.match(r.blocked!, /No document matches/);
  });

  test('blocks third-party documents from auto-upload', () => {
    const r = on('parents bank statement');
    assert.equal(r.best, null);
    assert.match(r.blocked!, /explicit approval/);
  });

  test('blocks password-protected files', () => {
    const r = on('acceptance letter');
    assert.equal(r.best, null);
    assert.match(r.blocked!, /password-protected/);
  });

  test('blocks unverified documents', () => {
    const m2 = ManifestSchema.parse({
      source_dir: 'x',
      documents: [{ key: 'cv', type: 'CV', file: 'cv.pdf', verified: false, aliases: ['cv'] }],
    });
    const r = matchDocument('CV', { manifest: m2 });
    assert.equal(r.best, null);
    assert.match(r.blocked!, /not human-verified/);
  });

  test('blocks an expired document', () => {
    const r = on('proof of residence', new Date('2027-01-15'));
    assert.equal(r.best, null);
    assert.match(r.blocked!, /expired on 2026-12-09/);
  });

  test('accepts the same document before it expires', () => {
    assert.equal(on('proof of residence', new Date('2026-11-01')).best?.entry.key, 'residence');
  });

  test('ignores CANDIDATE-status entries', () => {
    assert.equal(on('CV').best?.entry.key, 'cv');
  });
});
