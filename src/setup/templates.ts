/**
 * Starter files written by `spani init`.
 *
 * These are deliberately verbose. The profile is the single place a mistake
 * becomes a wrong answer on a real application, so the comments explain the
 * rules at the point where someone is actually typing.
 */

export const PROFILE_TEMPLATE = `# ══════════════════════════════════════════════════════════════════════
#  MASTER PROFILE
#  The single source of truth. Nothing about you is hardcoded anywhere else.
#
#  THE NULL RULE - the whole safety model rests on this:
#    null  = UNKNOWN. The agent will NOT answer from it; it asks you instead.
#    false = a confirmed "no".
#  Never change a null to false unless you mean "no". Collapsing unknown into
#  false is how an agent ends up telling an employer you have a licence you
#  do not have.
#
#  Fill in what you can. Leave the rest null - the agent will tell you which
#  gaps actually matter:  npm run spani -- review
#
#  Nothing in this file is ever sent to Claude as a VALUE. The model receives
#  paths like "personal.id_number"; code substitutes the digits.
# ══════════════════════════════════════════════════════════════════════

meta:
  version: 1
  updated_at: "REPLACE_DATE"
  # Set true only once you have read this whole file. Nothing is submitted
  # while it is false.
  verified_by_human: false

personal:
  first_name: ""
  surname: ""
  preferred_name: null
  title: null
  date_of_birth: null            # YYYY-MM-DD
  gender: null
  race: null                     # SA employment-equity forms ask; you may decline
  nationality: South African
  citizenship:
    country: ZA
    status: CITIZEN              # CITIZEN | PERMANENT_RESIDENT | WORK_PERMIT | OTHER
  id_number: null                # HIGH sensitivity: never logged, never prompted
  passport_number: null

  contact:
    email: ""
    phone: ""
    phone_alt: null
    linkedin: null
    github: null
    portfolio: null

  address:
    # Where you live during term. Used for "current address" fields.
    term:
      line1: null
      area: null
      city: null
      province: null
      postal_code: null
      country: South Africa
      rural: null
    # Permanent / home address. Asked separately on most bursary forms, and
    # several SA bursaries weight rural background.
    home:
      area: null
      town: null
      municipality: null
      ward: null
      province: null
      postal_code: null
      country: South Africa
      traditional_authority: null
      rural: null

  drivers_licence:
    has: null                    # asked constantly; often a listed requirement
    code: null
    own_vehicle: null

  disability:
    has: null
    details: null

  criminal_record: null

education:
  # The qualification you are registered for right now.
  current:
    qualification: ""
    institution: ""
    nqf_level: null
    credits: null
    start_year: null
    end_year: null
    expected_completion: null    # YYYY-MM
    status: IN_PROGRESS          # IN_PROGRESS | COMPLETED | ACCEPTED_NOT_STARTED | INCOMPLETE
    year_of_study: null
    student_number: null
    final_year_average: null
    cumulative_average: null
    key_modules: []
    # Copy these off your official transcript, not from memory.
    modules: []
    # - { name: Example Module 1A, mark: 72, distinction: false }

  # Accepted but not yet started. Bursary forms ask about this constantly.
  next: null

  previous: []

  school:
    name: null
    matric_year: null
    aps: null
    bachelors_pass: null
    subjects: []
    # - { name: Mathematics, mark: 78, level: 6, distinction: true }

# level: EXPOSURE | WORKING | PROFICIENT | ADVANCED
# category: LANGUAGE | FRAMEWORK | DATABASE | TOOL | CONCEPT | SOFT
skills: []
# - { name: SQL, category: DATABASE, level: PROFICIENT, evidence: "Where you actually used it" }

projects: []
# - name: Example Project
#   role: Developer
#   period: "2025"
#   description: >-
#     What it was and what you actually did.
#   technologies: []
#   responsibilities: []
#   outcome: null
#   team_size: null
#   tags: [backend, database]

# kind: WORK | FREELANCE | VOLUNTEER | LEADERSHIP | VACWORK | INTERNSHIP
experience: []

# kind: ACADEMIC | AWARD | CERTIFICATION | COMPETITION | LEADERSHIP | OTHER
achievements: []

preferences:
  target_types: [BURSARY, INTERNSHIP, GRADUATE, VACWORK, JOB]
  roles: []
  industries: []
  locations: []
  work_mode: [ONSITE, HYBRID, REMOTE]
  relocate:
    willing: null
    conditions: null
  salary:
    disclose: false              # never volunteered; always escalates to you
    expectation_zar_pm: null
    negotiable: true
  availability: null
  notice_period: null
  exclude_organisations: []

funding:
  nsfas:
    funded: null
    reference: null
  other_bursaries: []
  declares_no_other_funding: null
  household:
    combined_income_zar_pa: null # means-tested bursaries gate on this
    dependants: null
    guardian_employed: null

policy:
  auto_submit: false

  # Standing authorisation. A declaration category listed here is answered
  # from your profile without asking you every single time. Each is gated
  # twice: the category must be listed AND the underlying fact must be set,
  # so this is never a licence to invent.
  #
  # Available:
  #   information_true_and_correct   "I declare the information is true"
  #   popia_consent                  POPIA / data-processing consent
  #   terms_and_conditions
  #   criminal_record                needs personal.criminal_record set
  #   disability_status              needs personal.disability.has set
  #   race_declaration               needs personal.race set
  #   citizenship_declaration
  #
  # Start empty. Add categories once you are comfortable.
  pre_approved_declarations: []

  # Always escalated, whatever the profile holds. These are genuine
  # per-application judgements, not settled positions.
  never_answer:
    - salary_expectation
    - medical_history
    - political_affiliation

  never_auto_upload_types:
    - PARENT_ID
    - PARENT_BANK_STATEMENT
    - PAYSLIP
    - BANK_STATEMENT
    - AFFIDAVIT

  max_applications_per_day: 15
`;

export const MANIFEST_TEMPLATE = `# ══════════════════════════════════════════════════════════════════════
#  DOCUMENT MANIFEST
#  Maps your files to the SITUATIONS an application asks about, so the agent
#  uploads by meaning ("certified copy of ID") rather than by filename.
#
#  verified: false  → the agent will NOT upload it. Every row starts false.
#  Flip to true only once you have opened the file and confirmed what it is.
#
#  This is the highest-risk part of the whole system. Uploading an
#  uncertified ID where a certified one was required gets an application
#  silently rejected weeks later, and you never find out why.
# ══════════════════════════════════════════════════════════════════════

# Where your files live. Point this at your own folder, or drop files into
# data/documents/ and leave it as is.
source_dir: REPLACE_SOURCE_DIR

documents:
  # ── Worked example. Delete it and write your own. ──
  - key: id_certified
    type: ID_CERTIFIED
    file: identity/ID_Certified_2026-01-15.pdf
    description: Certified copy of ID, stamped at a police station
    # Phrases a form might use. More aliases = better matching.
    aliases:
      - certified id
      - certified copy of id
      - certified copy of your id
      - certified identity document
    certified: true
    sensitivity: HIGH
    valid_from: "2026-01-15"
    # Most SA bursaries require certification within 3 months. Past this
    # date the agent refuses to upload it and asks you instead.
    valid_until: "2026-04-15"
    verified: false

  # - key: transcript
  #   type: ACADEMIC_TRANSCRIPT
  #   file: academic/Transcript_2026.pdf
  #   aliases: [academic transcript, academic record, statement of results]
  #   verified: false

  # Third-party documents - a parent's ID or bank statement - are RED tier.
  # Mark them so, and they will never upload without explicit approval.
  # - key: parent_id
  #   type: PARENT_ID
  #   file: family/Parent_ID.pdf
  #   aliases: [parents id, guardian id]
  #   third_party: true
  #   sensitivity: HIGH
  #   never_auto_upload: true
  #   verified: false

# Files present on disk that are not documents, or are superseded copies.
ignore: []
`;

export const CONFIG_TEMPLATE = `{
  "ai": {
    "models": {
      "cheap": "claude-haiku-4-5-20251001",
      "writer": "claude-haiku-4-5-20251001"
    }
  },
  "budget": {
    "perRunUsd": 1.0,
    "perDayUsd": 1.5
  },
  "browser": {
    "channel": "chrome",
    "slowMoMs": 120
  },
  "policy": {
    "submitEnabled": false,
    "greenAfterSuccesses": 3,
    "urgentWithinDays": 5
  },
  "log": { "level": "info" }
}
`;

export const DATA_README = `# data/

Everything in this directory is yours and is gitignored in full. None of it is
committed, uploaded, or sent anywhere except to the application you are
deliberately submitting.

    profile/master.yaml      your facts. The single source of truth.
    profile/answers.yaml     answers you have vetted, reused across forms
    documents/manifest.yaml  what each file is and when it may be uploaded
    documents/              your actual files
    generated/              tailored CVs and motivations the agent produced
    browser-profile/        the agent's own Chrome profile, with its logins
    artifacts/              screenshots and page captures per run
    logs/                   structured run logs
    spani.db                opportunities, applications, step journal

If you back this up, treat it like you would your ID book.
`;
