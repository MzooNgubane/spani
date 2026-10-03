import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { check, explain, type Extraction } from '../src/eligibility/index.js';
import { ProfileSchema, type Profile } from '../src/profile/schema.js';

/** Thabo's real shape, trimmed to what the eligibility engine reads. */
const profile: Profile = ProfileSchema.parse({
  meta: { version: 1, updated_at: '2026-09-27', verified_by_human: true },
  personal: {
    first_name: 'Thabo', surname: 'Mokoena',
    citizenship: { country: 'ZA', status: 'CITIZEN' },
    contact: { email: 'a@b.test', phone: '0000000000' },
    address: { home: { province: 'Limpopo', rural: true } },
    drivers_licence: { has: null },      // UNKNOWN, on purpose
  },
  education: {
    current: {
      qualification: 'Diploma in Information Technology',
      institution: 'Example University of Technology',
      nqf_level: 6, status: 'IN_PROGRESS', year_of_study: 3,
      final_year_average: 78.5, cumulative_average: 71.2,
      expected_completion: '2027-04',
    },
  },
  preferences: {},
  funding: { nsfas: { funded: true } },
});

const extraction = (criteria: Extraction['criteria']): Extraction => ({
  organisation: 'Test', title: 'Test Bursary', type: 'BURSARY', closing_date: null, criteria,
});

describe('eligibility engine', () => {
  test('passes when every mandatory criterion is met', () => {
    const a = check(extraction([
      { kind: 'CITIZENSHIP', text: 'SA citizen', op: 'equals', value: 'CITIZEN', mandatory: true },
      { kind: 'FIELD_OF_STUDY', text: 'IT or Computer Science', op: 'in',
        value: ['Information Technology', 'Computer Science'], mandatory: true },
      { kind: 'ACADEMIC_AVERAGE', text: 'Minimum 65% average', op: 'at_least', value: 65, mandatory: true },
    ]), profile);
    assert.equal(a.verdict, 'ELIGIBLE');
    assert.equal(a.checked.filter((c) => c.verdict === 'PASS').length, 3);
  });

  test('matches a field of study by substring in either direction', () => {
    const a = check(extraction([
      { kind: 'FIELD_OF_STUDY', text: 'Information Technology', op: 'in',
        value: ['Information Technology'], mandatory: true },
    ]), profile);
    // "Diploma in Information Technology" satisfies "Information Technology"
    assert.equal(a.checked[0]!.verdict, 'PASS');
  });

  test('fails on an unmet mandatory threshold', () => {
    const a = check(extraction([
      { kind: 'ACADEMIC_AVERAGE', text: 'Minimum 85% average', op: 'at_least', value: 85, mandatory: true },
    ]), profile);
    assert.equal(a.verdict, 'NOT_ELIGIBLE');
  });

  test('tries the next path before failing on averages', () => {
    // final_year_average 78.5 passes where cumulative 71.2 would too; with a
    // threshold between them the higher one must be the one that decides.
    const a = check(extraction([
      { kind: 'ACADEMIC_AVERAGE', text: 'Minimum 75%', op: 'at_least', value: 75, mandatory: true },
    ]), profile);
    assert.equal(a.verdict, 'ELIGIBLE');
    assert.equal(a.checked[0]!.profileRef, 'education.current.final_year_average');
  });

  // The null rule: an unknown must never be silently read as "no".
  test('an unknown mandatory value yields UNCERTAIN, not NOT_ELIGIBLE', () => {
    const a = check(extraction([
      { kind: 'DRIVERS_LICENCE', text: "Valid driver's licence required", op: 'has',
        value: 'true', mandatory: true },
    ]), profile);
    assert.equal(a.verdict, 'UNCERTAIN');
    assert.equal(a.checked[0]!.verdict, 'UNKNOWN');
    assert.equal(a.openQuestions.length, 1);
  });

  test('an unknown NON-mandatory value does not block eligibility', () => {
    const a = check(extraction([
      { kind: 'CITIZENSHIP', text: 'SA citizen', op: 'equals', value: 'CITIZEN', mandatory: true },
      { kind: 'DRIVERS_LICENCE', text: "Driver's licence advantageous", op: 'has',
        value: 'true', mandatory: false },
    ]), profile);
    assert.equal(a.verdict, 'ELIGIBLE');
    assert.equal(a.openQuestions.length, 1, 'still surfaced as a question');
  });

  test('a failed mandatory criterion beats an unknown one', () => {
    const a = check(extraction([
      { kind: 'DRIVERS_LICENCE', text: 'Licence', op: 'has', value: 'true', mandatory: true },
      { kind: 'ACADEMIC_AVERAGE', text: 'Minimum 90%', op: 'at_least', value: 90, mandatory: true },
    ]), profile);
    assert.equal(a.verdict, 'NOT_ELIGIBLE');
  });

  test('handles between, at_most and boolean funding status', () => {
    const a = check(extraction([
      { kind: 'YEAR_OF_STUDY', text: 'Year 2 or 3', op: 'between', value: [2, 3], mandatory: true },
      { kind: 'QUALIFICATION_LEVEL', text: 'NQF 6 or below', op: 'at_most', value: 6, mandatory: true },
      { kind: 'FUNDING_STATUS', text: 'Must be NSFAS funded', op: 'has', value: 'true', mandatory: true },
    ]), profile);
    assert.equal(a.verdict, 'ELIGIBLE');
  });

  test('marks criteria no profile field covers as NOT_CHECKABLE', () => {
    const a = check(extraction([
      { kind: 'OTHER', text: 'Must submit a 5-minute video', op: 'has', value: 'true', mandatory: true },
    ]), profile);
    assert.equal(a.checked[0]!.verdict, 'NOT_CHECKABLE');
    assert.equal(a.verdict, 'UNCERTAIN');
  });

  test('no criteria means eligible, not uncertain', () => {
    assert.equal(check(extraction([]), profile).verdict, 'ELIGIBLE');
  });

  test('explanation cites the profile field behind every verdict', () => {
    const a = check(extraction([
      { kind: 'CITIZENSHIP', text: 'SA citizen', op: 'equals', value: 'CITIZEN', mandatory: true },
      { kind: 'DRIVERS_LICENCE', text: "Driver's licence", op: 'has', value: 'true', mandatory: true },
    ]), profile);
    const text = explain({ ...a, costUsd: 0 }, 'Test Bursary');
    assert.match(text, /UNCERTAIN/);
    assert.match(text, /personal\.citizenship\.status = CITIZEN/);
    assert.match(text, /is not set in your profile/);
  });
});

describe('derived profile paths', () => {
  test('full name is resolvable even though it is not stored', async () => {
    const { resolve, isKnown } = await import('../src/profile/index.js');
    assert.equal(resolve('personal.full_name', profile), 'Thabo Mokoena');
    assert.equal(isKnown(resolve('personal.full_name', profile)), true);
  });

  test('derived paths are offered to the mapper', async () => {
    const { promptablePaths } = await import('../src/profile/index.js');
    const paths = promptablePaths(profile).map((p) => p.path);
    assert.ok(paths.includes('personal.full_name'));
    assert.ok(paths.includes('personal.address.home.full'));
  });

  test('a derived path built from unknown parts stays unknown', async () => {
    const { resolve, UNKNOWN } = await import('../src/profile/index.js');
    // term address has no line1/city set in this fixture
    assert.equal(resolve('personal.address.term.full', profile), UNKNOWN);
  });
});

describe('prose requirements must not become false negatives', () => {
  // The bug this guards: a real ISFAP listing produced criteria whose values
  // were sentences. String-matching them returned FAIL, and the engine
  // confidently reported NOT_ELIGIBLE for a bursary he plainly qualifies for.
  test('a prose requirement yields UNKNOWN, never FAIL', () => {
    const a = check(extraction([
      { kind: 'INSTITUTION', text: 'Must be enrolled at an accredited university',
        op: 'equals', value: 'enrolled or planning to enroll in an accredited South African university',
        mandatory: true },
    ]), profile);
    assert.equal(a.checked[0]!.verdict, 'UNKNOWN');
    assert.equal(a.verdict, 'UNCERTAIN', 'asks, rather than discarding the opportunity');
  });

  test('a short closed enumeration still fails properly', () => {
    const a = check(extraction([
      { kind: 'LOCATION', text: 'Western Cape residents only', op: 'in',
        value: ['Western Cape'], mandatory: true },
    ]), profile);
    assert.equal(a.checked[0]!.verdict, 'FAIL');
    assert.equal(a.verdict, 'NOT_ELIGIBLE');
  });

  test('numeric thresholds stay definitive', () => {
    const fail = check(extraction([
      { kind: 'ACADEMIC_AVERAGE', text: 'Minimum 90%', op: 'at_least', value: 90, mandatory: true },
    ]), profile);
    assert.equal(fail.verdict, 'NOT_ELIGIBLE', 'a number is checkable, so FAIL is honest');
  });

  test('a prose field-of-study requirement does not discard an IT student', () => {
    const a = check(extraction([
      { kind: 'FIELD_OF_STUDY', text: 'Occupation of High Demand', op: 'equals',
        value: 'pursuing a qualification in an occupation of high demand', mandatory: true },
      { kind: 'CITIZENSHIP', text: 'SA citizen', op: 'equals', value: 'CITIZEN', mandatory: true },
    ]), profile);
    assert.notEqual(a.verdict, 'NOT_ELIGIBLE');
  });
});

describe('FAIL requires a closed set of acceptable values', () => {
  test('a category label is not a checkable field of study', () => {
    // "Occupation of High Demand" is a label, not a list of degrees.
    const a = check(extraction([
      { kind: 'FIELD_OF_STUDY', text: 'Occupation of High Demand', op: 'equals',
        value: 'Occupation of High Demand', mandatory: true },
    ]), profile);
    assert.equal(a.checked[0]!.verdict, 'UNKNOWN');
    assert.notEqual(a.verdict, 'NOT_ELIGIBLE');
  });

  test('an enumerated field-of-study list still fails properly', () => {
    const a = check(extraction([
      { kind: 'FIELD_OF_STUDY', text: 'Medicine or Nursing only', op: 'in',
        value: ['Medicine', 'Nursing', 'Pharmacy'], mandatory: true },
    ]), profile);
    assert.equal(a.checked[0]!.verdict, 'FAIL');
    assert.equal(a.verdict, 'NOT_ELIGIBLE');
  });

  test('a closed-vocabulary kind still fails on a real mismatch', () => {
    const a = check(extraction([
      { kind: 'CITIZENSHIP', text: 'Permanent residents only', op: 'equals',
        value: 'PERMANENT_RESIDENT', mandatory: true },
    ]), profile);
    assert.equal(a.checked[0]!.verdict, 'FAIL');
  });

  test('a vague academic requirement does not discard the opportunity', () => {
    const a = check(extraction([
      { kind: 'ACADEMIC_AVERAGE', text: 'Maintain academic performance standards',
        op: 'equals', value: 'good academic standing', mandatory: true },
    ]), profile);
    assert.equal(a.checked[0]!.verdict, 'UNKNOWN');
  });
});

describe('field-of-study synonyms', () => {
  // The live failure: ISFAP listed occupations, not degree names, and an IT
  // student was marked NOT_ELIGIBLE for an IT bursary.
  test('matches an occupation list against a qualification name', () => {
    const a = check(extraction([
      { kind: 'FIELD_OF_STUDY', text: 'Occupations of High Demand', op: 'in',
        value: ['Actuaries', 'Accountants', 'Data Scientists', 'Engineers',
                'IT Professionals', 'Medical Doctors', 'Nurses'], mandatory: true },
    ]), profile);
    assert.equal(a.checked[0]!.verdict, 'PASS');
  });

  test('matches bare "IT" and "ICT"', () => {
    for (const v of [['IT'], ['ICT'], ['Computer Science', 'IT']]) {
      const a = check(extraction([
        { kind: 'FIELD_OF_STUDY', text: 'IT fields', op: 'in', value: v, mandatory: true },
      ]), profile);
      assert.equal(a.checked[0]!.verdict, 'PASS', `expected PASS for ${v.join('/')}`);
    }
  });

  test('does not stretch to an unrelated field', () => {
    const a = check(extraction([
      { kind: 'FIELD_OF_STUDY', text: 'Health sciences only', op: 'in',
        value: ['Medicine', 'Nursing', 'Pharmacy'], mandatory: true },
    ]), profile);
    assert.equal(a.checked[0]!.verdict, 'FAIL');
  });

  test('an institution name mismatch is never a fail', () => {
    const a = check(extraction([
      { kind: 'INSTITUTION', text: 'Must attend a public university', op: 'equals',
        value: 'public university', mandatory: true },
    ]), profile);
    assert.equal(a.checked[0]!.verdict, 'UNKNOWN');
  });
});
