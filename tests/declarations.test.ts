import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileSchema, type Profile } from '../src/profile/schema.js';
import { enforceForTest } from '../src/engine/fieldmap.js';
import type { PageSnapshot, Field } from '../src/browser/snapshot.js';
import type { Mapping } from '../src/engine/fieldmap.js';

const base = {
  meta: { version: 1, updated_at: '2026-09-30', verified_by_human: true },
  personal: {
    first_name: 'Thabo', surname: 'Mokoena',
    contact: { email: 'a@b.test', phone: '0000000000' },
    citizenship: { country: 'ZA', status: 'CITIZEN' },
    race: 'Black African',
    criminal_record: false,
    disability: { has: false },
  },
  education: {
    current: {
      qualification: 'Diploma in Information Technology',
      institution: 'Example University of Technology', status: 'IN_PROGRESS',
    },
  },
  preferences: {},
};

const authorised: Profile = ProfileSchema.parse({
  ...base,
  policy: {
    pre_approved_declarations: [
      'information_true_and_correct', 'popia_consent', 'terms_and_conditions',
      'criminal_record', 'disability_status', 'race_declaration',
    ],
    never_answer: ['salary_expectation', 'medical_history', 'political_affiliation'],
  },
});

const unauthorised: Profile = ProfileSchema.parse(base);

/** Profile that authorises the criminal-record declaration but has no answer. */
const authorisedButUnknown: Profile = ProfileSchema.parse({
  ...base,
  personal: { ...base.personal, criminal_record: null },
  policy: { pre_approved_declarations: ['criminal_record'] },
});

function snapshotOf(fields: Array<Partial<Field> & { ref: string; label: string }>): PageSnapshot {
  return {
    url: 'https://test.invalid/apply', title: 'Apply', heading: null,
    fields: fields.map((f) => ({ kind: 'checkbox', required: true, ...f } as Field)),
    buttons: [], errors: [], stepIndicator: null, signature: 'sig', approxTokens: 0,
  };
}

const check = (ref: string, value: string): Mapping =>
  ({ ref, action: 'CHECK', value, confidence: 0.9 } as Mapping);

describe('standing declaration authorisation', () => {
  test('ticks an authorised truthfulness declaration', () => {
    const snap = snapshotOf([{ ref: 'f1', label: 'I declare that the information provided is true and correct' }]);
    const { clean } = enforceForTest([check('f1', 'true')], snap, authorised);
    assert.equal(clean[0]!.action, 'CHECK');
  });

  test('ticks an authorised POPIA consent', () => {
    const snap = snapshotOf([{ ref: 'f1', label: 'I consent to the processing of my personal information under POPIA' }]);
    const { clean } = enforceForTest([check('f1', 'true')], snap, authorised);
    assert.equal(clean[0]!.action, 'CHECK');
  });

  test('answers the criminal-record question from the confirmed profile value', () => {
    const snap = snapshotOf([{ ref: 'f1', label: 'I confirm I have no criminal record' }]);
    const { clean } = enforceForTest([check('f1', 'true')], snap, authorised);
    assert.equal(clean[0]!.action, 'CHECK');
  });

  // Without the standing grant, the old behaviour must be exactly preserved.
  test('escalates every declaration when nothing is authorised', () => {
    const snap = snapshotOf([
      { ref: 'f1', label: 'I declare that the information provided is true and correct' },
      { ref: 'f2', label: 'I consent to POPIA processing' },
      { ref: 'f3', label: 'I confirm I have no criminal record' },
    ]);
    const { clean } = enforceForTest(
      [check('f1', 'true'), check('f2', 'true'), check('f3', 'true')], snap, unauthorised,
    );
    assert.ok(clean.every((m) => m.action === 'ESCALATE'), 'all three escalate');
  });

  // Authorisation is not a licence to invent: the fact must exist.
  test('escalates an authorised declaration whose profile value is unknown', () => {
    const snap = snapshotOf([{ ref: 'f1', label: 'Do you have a criminal record?' }]);
    const { clean } = enforceForTest([check('f1', 'false')], snap, authorisedButUnknown);
    assert.equal(clean[0]!.action, 'ESCALATE');
    assert.match(clean[0]!.reason!, /personal\.criminal_record is not set/);
  });

  test('salary still escalates even with broad authorisation', () => {
    const snap = snapshotOf([{ ref: 'f1', label: 'What is your expected salary?', kind: 'text' }]);
    const { clean } = enforceForTest(
      [{ ref: 'f1', action: 'FILL', profile_path: 'preferences.salary.expectation_zar_pm', confidence: 0.9 } as Mapping],
      snap, authorised,
    );
    assert.equal(clean[0]!.action, 'ESCALATE');
  });

  test('medical and political questions still escalate', () => {
    const snap = snapshotOf([
      { ref: 'f1', label: 'Do you have any chronic medical conditions?' },
      { ref: 'f2', label: 'State your political affiliation' , kind: 'text' },
    ]);
    const { clean } = enforceForTest([check('f1', 'false'), check('f2', 'false')], snap, authorised);
    assert.ok(clean.every((m) => m.action === 'ESCALATE'));
  });

  // "I confirm I have no criminal record" matches both the criminal pattern and
  // the generic "I confirm" one; it must classify as criminal_record.
  test('classifies a compound declaration by its most specific pattern', () => {
    const snap = snapshotOf([{ ref: 'f1', label: 'I hereby confirm that I have no criminal record' }]);
    const onlyTruth = ProfileSchema.parse({
      ...base, policy: { pre_approved_declarations: ['information_true_and_correct'] },
    });
    const { clean } = enforceForTest([check('f1', 'true')], snap, onlyTruth);
    assert.equal(clean[0]!.action, 'ESCALATE', 'truthfulness grant must not cover criminal record');
    assert.match(clean[0]!.reason!, /criminal_record/);
  });

  test('an ordinary field is unaffected', () => {
    const snap = snapshotOf([{ ref: 'f1', label: 'First name', kind: 'text' }]);
    const { clean } = enforceForTest(
      [{ ref: 'f1', action: 'FILL', profile_path: 'personal.first_name', confidence: 0.9 } as Mapping],
      snap, authorised,
    );
    assert.equal(clean[0]!.action, 'FILL');
  });
});
