import { z } from 'zod';

/**
 * The Master Profile contract.
 *
 * THE NULL RULE, which the whole safety model rests on:
 *   null   = UNKNOWN. The agent must never answer from it. Escalates to you.
 *   false  = a confirmed "no".
 *   absent = same as null.
 * Collapsing null into false is how an automation agent ends up telling an
 * employer you have a driver's licence you do not have. Every optional answer
 * is therefore `.nullable()` with an explicit default of null, never `false`.
 */

const Nullable = <T extends z.ZodTypeAny>(s: T) => s.nullable().default(null);

export const ContactSchema = z.object({
  // An empty string is allowed so a freshly generated template loads. It
  // resolves to UNKNOWN, so the agent escalates rather than filling a blank
  // email into a form.
  email: z.union([z.string().email(), z.literal('')]),
  phone: z.string(),
  phone_alt: Nullable(z.string()),
  linkedin: Nullable(z.string()),
  github: Nullable(z.string()),
  portfolio: Nullable(z.string()),
});

export const AddressSchema = z.object({
  line1: Nullable(z.string()),
  area: Nullable(z.string()),
  city: Nullable(z.string()),
  town: Nullable(z.string()),
  municipality: Nullable(z.string()),
  ward: Nullable(z.union([z.string(), z.number()])),
  province: Nullable(z.string()),
  postal_code: Nullable(z.string()),
  country: z.string().default('South Africa'),
  traditional_authority: Nullable(z.string()),
  /** Several SA bursaries weight rural background. Record it, do not infer it. */
  rural: Nullable(z.boolean()),
});

export const PersonalSchema = z.object({
  first_name: z.string(),
  surname: z.string(),
  preferred_name: Nullable(z.string()),
  title: Nullable(z.string()),
  date_of_birth: Nullable(z.string()),
  gender: Nullable(z.string()),
  race: Nullable(z.string()),            // SA employment-equity forms ask; you may decline
  nationality: z.string().default('South African'),
  citizenship: z.object({
    country: z.string().default('ZA'),
    status: z.enum(['CITIZEN', 'PERMANENT_RESIDENT', 'WORK_PERMIT', 'OTHER']).default('CITIZEN'),
  }).default({}),
  /** HIGH sensitivity. Never enters an AI prompt - see SENSITIVE_PATHS. */
  id_number: Nullable(z.string()),
  passport_number: Nullable(z.string()),
  contact: ContactSchema,
  address: z.object({
    term: AddressSchema.partial().optional(),
    home: AddressSchema.partial().optional(),
  }).default({}),
  drivers_licence: z.object({
    has: Nullable(z.boolean()),
    code: Nullable(z.string()),
    own_vehicle: Nullable(z.boolean()),
  }).default({}),
  disability: z.object({
    has: Nullable(z.boolean()),
    details: Nullable(z.string()),
  }).default({}),
  criminal_record: Nullable(z.boolean()),
});

export const SubjectMarkSchema = z.object({
  name: z.string(),
  mark: Nullable(z.number()),
  level: Nullable(z.number()),
  distinction: z.boolean().default(false),
});

export const QualificationSchema = z.object({
  qualification: z.string(),
  institution: z.string(),
  nqf_level: Nullable(z.number()),
  credits: Nullable(z.number()),
  start_year: Nullable(z.number()),
  end_year: Nullable(z.number()),
  expected_completion: Nullable(z.string()),
  status: z.enum(['IN_PROGRESS', 'COMPLETED', 'ACCEPTED_NOT_STARTED', 'INCOMPLETE']),
  year_of_study: Nullable(z.number()),
  student_number: Nullable(z.string()),
  final_year_average: Nullable(z.number()),
  cumulative_average: Nullable(z.number()),
  modules: z.array(SubjectMarkSchema).default([]),
  key_modules: z.array(z.string()).default([]),
});

export const EducationSchema = z.object({
  /** The qualification you are registered for right now. */
  current: QualificationSchema,
  /** Accepted but not yet started. Bursary forms ask about this constantly. */
  next: Nullable(QualificationSchema),
  previous: z.array(QualificationSchema).default([]),
  school: z.object({
    name: Nullable(z.string()),
    matric_year: Nullable(z.number()),
    aps: Nullable(z.number()),
    bachelors_pass: Nullable(z.boolean()),
    subjects: z.array(SubjectMarkSchema).default([]),
  }).default({}),
});

export const SkillSchema = z.object({
  name: z.string(),
  category: z.enum(['LANGUAGE', 'FRAMEWORK', 'DATABASE', 'TOOL', 'CONCEPT', 'SOFT']),
  level: z.enum(['EXPOSURE', 'WORKING', 'PROFICIENT', 'ADVANCED']),
  evidence: Nullable(z.string()),
});

export const ProjectSchema = z.object({
  name: z.string(),
  role: z.string(),
  period: Nullable(z.string()),
  context: Nullable(z.string()),
  description: z.string(),
  technologies: z.array(z.string()).default([]),
  responsibilities: z.array(z.string()).default([]),
  outcome: Nullable(z.string()),
  team_size: Nullable(z.number()),
  /** Tags the CV relevance scorer matches against an opportunity. */
  tags: z.array(z.string()).default([]),
});

export const ExperienceSchema = z.object({
  kind: z.enum(['WORK', 'FREELANCE', 'VOLUNTEER', 'LEADERSHIP', 'VACWORK', 'INTERNSHIP']),
  organisation: z.string(),
  role: z.string(),
  start: Nullable(z.string()),
  end: Nullable(z.string()),
  current: z.boolean().default(false),
  responsibilities: z.array(z.string()).default([]),
  achievements: z.array(z.string()).default([]),
  reference: Nullable(z.object({
    name: z.string(), role: Nullable(z.string()),
    email: Nullable(z.string()), phone: Nullable(z.string()),
  })),
});

export const AchievementSchema = z.object({
  name: z.string(),
  issuer: Nullable(z.string()),
  year: Nullable(z.number()),
  kind: z.enum(['ACADEMIC', 'AWARD', 'CERTIFICATION', 'COMPETITION', 'LEADERSHIP', 'OTHER']),
  detail: Nullable(z.string()),
});

export const PreferencesSchema = z.object({
  target_types: z.array(z.enum(['BURSARY', 'INTERNSHIP', 'GRADUATE', 'LEARNERSHIP', 'JOB', 'VACWORK'])).default([]),
  roles: z.array(z.string()).default([]),
  industries: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  work_mode: z.array(z.enum(['ONSITE', 'HYBRID', 'REMOTE'])).default([]),
  relocate: z.object({
    willing: Nullable(z.boolean()),
    conditions: Nullable(z.string()),
  }).default({}),
  salary: z.object({
    disclose: z.boolean().default(false),
    expectation_zar_pm: Nullable(z.number()),
    negotiable: z.boolean().default(true),
  }).default({}),
  availability: Nullable(z.string()),
  notice_period: Nullable(z.string()),
  exclude_organisations: z.array(z.string()).default([]),
});

export const FundingSchema = z.object({
  nsfas: z.object({
    funded: Nullable(z.boolean()),
    reference: Nullable(z.string()),
  }).default({}),
  other_bursaries: z.array(z.string()).default([]),
  /** Affidavit.pdf attests to this. Many bursaries make it a hard exclusion. */
  declares_no_other_funding: Nullable(z.boolean()),
  household: z.object({
    combined_income_zar_pa: Nullable(z.number()),
    dependants: Nullable(z.number()),
    guardian_employed: Nullable(z.boolean()),
  }).default({}),
});

/**
 * Declaration categories the user can authorise ONCE, standing.
 *
 * These are a person's settled position, not a per-application judgement:
 * "the information I gave is true", "I consent to POPIA processing". Escalating
 * them every time would mean babysitting every single application, which
 * defeats the point. Anything NOT on this list still escalates.
 */
export const DECLARATION_CATEGORIES = [
  'information_true_and_correct',
  'popia_consent',
  'terms_and_conditions',
  'criminal_record',          // only honoured when personal.criminal_record is set
  'disability_status',        // only honoured when personal.disability.has is set
  'race_declaration',         // only honoured when personal.race is set
  'citizenship_declaration',
] as const;

export type DeclarationCategory = typeof DECLARATION_CATEGORIES[number];

export const PolicySchema = z.object({
  auto_submit: z.boolean().default(false),
  /**
   * Standing authorisation. A category here is answered from the profile
   * without asking. Empty by default - it must be granted deliberately.
   */
  pre_approved_declarations: z.array(z.enum(DECLARATION_CATEGORIES)).default([]),
  /** Questions matching these ALWAYS escalate, whatever the profile holds. */
  never_answer: z.array(z.string()).default([
    'criminal_record', 'disability_status', 'race_declaration',
    'salary_expectation', 'medical_history', 'political_affiliation',
  ]),
  /** Documents that may never be uploaded without explicit per-application approval. */
  never_auto_upload_types: z.array(z.string()).default([
    'PARENT_ID', 'PARENT_BANK_STATEMENT', 'PAYSLIP', 'BANK_STATEMENT', 'AFFIDAVIT',
  ]),
  max_applications_per_day: z.number().int().positive().default(15),
});

export const ProfileSchema = z.object({
  meta: z.object({
    version: z.number().int().default(1),
    updated_at: z.string(),
    /** Set true only after you have reviewed the whole file. */
    verified_by_human: z.boolean().default(false),
  }),
  personal: PersonalSchema,
  education: EducationSchema,
  skills: z.array(SkillSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  experience: z.array(ExperienceSchema).default([]),
  achievements: z.array(AchievementSchema).default([]),
  preferences: PreferencesSchema,
  funding: FundingSchema.default({}),
  policy: PolicySchema.default({}),
});

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Dot-paths whose VALUES are never placed in an AI prompt, never logged, and
 * stored redacted in field_fills. Claude receives the path; deterministic code
 * substitutes the value directly into the browser.
 */
export const SENSITIVE_PATHS: readonly string[] = [
  'personal.id_number',
  'personal.passport_number',
  'personal.date_of_birth',
  'personal.race',
  'personal.disability',
  'personal.criminal_record',
  'funding.household',
  'preferences.salary',
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATHS.some((p) => path === p || path.startsWith(`${p}.`));
}

/**
 * Paths that real SA bursary / graduate / internship forms ask for often enough
 * that a null here will block or delay applications. The review checklist leads
 * with these so one sitting clears the things that actually matter, instead of
 * 56 fields of which most never appear on a form.
 */
export const BLOCKING_PATHS: readonly string[] = [
  'personal.id_number',
  'personal.date_of_birth',
  'personal.gender',
  'personal.race',
  'personal.drivers_licence.has',
  'personal.criminal_record',
  'personal.disability.has',
  'personal.address.term.line1',
  'personal.address.term.postal_code',
  'education.next.qualification',
  'education.school.name',
  'education.school.matric_year',
  'education.school.aps',
  'education.school.bachelors_pass',
  'funding.nsfas.funded',
  'funding.household.combined_income_zar_pa',
  'funding.household.dependants',
  'preferences.relocate.willing',
  'preferences.availability',
];

/** Why each blocking path matters, shown in the review checklist. */
export const BLOCKING_REASONS: Readonly<Record<string, string>> = {
  'personal.id_number': 'required on virtually every SA application',
  'personal.date_of_birth': 'required on most forms; also used for age-limit eligibility',
  'personal.gender': 'employment-equity forms',
  'personal.race': 'employment-equity forms (you may also choose to decline)',
  'personal.drivers_licence.has': 'asked constantly; often a listed requirement',
  'personal.criminal_record': 'declaration on most graduate programmes',
  'personal.disability.has': 'employment-equity forms',
  'personal.address.term.line1': 'physical address fields',
  'personal.address.term.postal_code': 'physical address fields',
  'education.next.qualification': 'exact title of the 2027 Advanced Diploma',
  'education.school.name': 'asked on almost every bursary form',
  'education.school.matric_year': 'asked on almost every bursary form',
  'education.school.aps': 'bursary eligibility thresholds',
  'education.school.bachelors_pass': 'bursary eligibility thresholds',
  'funding.nsfas.funded': 'inferred as true from Proof_of_nfsas.pdf - confirm',
  'funding.household.combined_income_zar_pa': 'means-tested bursaries gate on this',
  'funding.household.dependants': 'means-tested bursaries gate on this',
  'preferences.relocate.willing': 'asked on most graduate programmes',
  'preferences.availability': 'asked on most job and internship forms',
};

export function isBlockingPath(path: string): boolean {
  return BLOCKING_PATHS.includes(path);
}
