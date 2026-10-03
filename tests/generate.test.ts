import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/engine/generate.js';
import { ProfileSchema, type Profile } from '../src/profile/schema.js';

const profile: Profile = ProfileSchema.parse({
  meta: { version: 1, updated_at: '2026-09-27', verified_by_human: true },
  personal: {
    first_name: 'Thabo', surname: 'Mokoena',
    contact: { email: 'a@b.test', phone: '0000000000' },
  },
  education: {
    current: {
      qualification: 'Diploma in Information Technology',
      institution: 'Example University of Technology',
      nqf_level: 6, status: 'IN_PROGRESS', year_of_study: 3,
      final_year_average: 78.5,
    },
  },
  skills: [
    { name: 'SQL', category: 'DATABASE', level: 'PROFICIENT' },
    { name: 'C#', category: 'LANGUAGE', level: 'PROFICIENT' },
  ],
  projects: [{
    name: 'Campus Services Platform', role: 'Backend Developer & Team Lead',
    description: 'Led a five-person team building a backend.', team_size: 5,
  }],
  achievements: [{ name: 'Deans Merit Award', kind: 'ACADEMIC', year: 2024 }],
  preferences: {},
});

const refs = ['education.current.qualification', 'education.current.institution'];

describe('fact validator', () => {
  test('accepts an answer built only from real facts', () => {
    const r = validate(
      'I am studying a Diploma in Information Technology at Example University ' +
      'of Technology, where I have focused on SQL and backend development.',
      [...refs, 'skills.0.name'], profile,
    );
    assert.equal(r.passed, true, r.notes.join('; '));
  });

  // The failure mode this whole module exists to prevent.
  test('rejects an invented employer', () => {
    const r = validate(
      'During my internship at Standard Bank I built reporting pipelines.',
      refs, profile,
    );
    assert.equal(r.passed, false);
    assert.ok(r.notes.some((n) => n.includes('Standard Bank')));
  });

  test('rejects an invented grade', () => {
    const r = validate('I achieved a final-year average of 88%.', refs, profile);
    assert.equal(r.passed, false);
    assert.ok(r.notes.some((n) => n.includes('88')));
  });

  test('accepts a grade that is actually in the profile', () => {
    const r = validate(
      'I achieved a final-year average of 78.5% in my Diploma in Information Technology.',
      [...refs, 'education.current.final_year_average'], profile,
    );
    assert.equal(r.passed, true, r.notes.join('; '));
  });

  test('rejects an invented certification', () => {
    const r = validate('I hold an AWS Certified Solutions Architect certification.', refs, profile);
    assert.equal(r.passed, false);
    assert.ok(r.notes.some((n) => /AWS/.test(n)));
  });

  test('rejects overclaimed seniority', () => {
    const r = validate(
      'I have five years of professional experience in software development.',
      refs, profile,
    );
    assert.equal(r.passed, false);
    assert.ok(r.notes.some((n) => n.includes('overclaims')));
  });

  test('rejects a citation the profile cannot back', () => {
    const r = validate('I am a student.', ['experience.0.organisation'], profile);
    assert.equal(r.passed, false);
    assert.ok(r.notes.some((n) => n.includes('does not have')));
  });

  test('allows ordinary small numbers in prose', () => {
    const r = validate('I led a team of 5 students on one project.',
      [...refs, 'projects.0.team_size'], profile);
    assert.equal(r.passed, true, r.notes.join('; '));
  });

  test('allows a real achievement by name', () => {
    const r = validate(
      'I received the Deans Merit Award at Example University of Technology.',
      [...refs, 'achievements.0.name'], profile,
    );
    assert.equal(r.passed, true, r.notes.join('; '));
  });
});

describe('citation validity', () => {
  test('accepts a container path as a citation', () => {
    // "skills" and "projects.0.technologies" are real parts of the profile
    // even though neither resolves to a single scalar.
    const r = validate('I work with SQL and C#.', ['skills', 'projects.0.name'], profile);
    assert.equal(r.passed, true, r.notes.join('; '));
  });

  test('still rejects a container path that does not exist', () => {
    const r = validate('I am a student.', ['certifications'], profile);
    assert.equal(r.passed, false);
    assert.ok(r.notes.some((n) => n.includes('certifications')));
  });
});

describe('opportunity context', () => {
  test('allows the organisation name the advert supplied', () => {
    // "Ubuntu" is not a fact about the applicant, but naming the employer in a
    // "why do you want to join us" answer is the whole point of the question.
    const bare = validate('I want to join Ubuntu because of its graduate training.', refs, profile);
    assert.equal(bare.passed, false, 'rejected without context');

    const withCtx = validate('I want to join Ubuntu because of its graduate training.',
      refs, profile, 'Ubuntu Graduate Programme 2027');
    assert.equal(withCtx.passed, true, withCtx.notes.join('; '));
  });

  test('context does not license an invented employer history', () => {
    const r = validate('During my two years at Ubuntu I led the platform team.',
      refs, profile, 'Ubuntu Graduate Programme 2027');
    assert.equal(r.passed, false, 'still catches the fabricated tenure');
  });
});

describe('citation annotations and article-prefixed entities', () => {
  // Models label citations for readability. Exact-path matching read every
  // annotated citation as a fabricated path and rejected good answers.
  test('accepts a citation annotated with its value', () => {
    const r = validate('I work with SQL.', ['skills.0 (SQL)', 'projects.0 (Campus Services Platform)'], profile);
    assert.equal(r.passed, true, r.notes.join('; '));
  });

  test('still rejects an annotated path that does not exist', () => {
    const r = validate('I am a student.', ['certifications.0 (AWS)'], profile);
    assert.equal(r.passed, false);
    assert.ok(r.notes.some((n) => n.includes('certifications.0')));
  });

  test('an article before the organisation name is not a fabrication', () => {
    const r = validate('I want to join the IDC because of its industrial focus.',
      ['education.current.qualification'], profile, 'IDC Industrial Development Corporation');
    assert.equal(r.passed, true, r.notes.join('; '));
  });
});
