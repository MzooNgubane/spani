-- ─────────────────────────────────────────────────────────────
-- Spani initial schema
-- Conventions: ids are TEXT uuid, timestamps are ISO-8601 TEXT UTC,
-- *_json columns hold JSON validated by zod at the repository layer.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE opportunities (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,                -- MANUAL | adapter/source key
  external_id     TEXT,
  url             TEXT NOT NULL UNIQUE,
  url_canonical   TEXT NOT NULL,                -- tracking params stripped
  title           TEXT NOT NULL,
  organisation    TEXT,
  type            TEXT NOT NULL CHECK (type IN
                    ('BURSARY','INTERNSHIP','GRADUATE','LEARNERSHIP','JOB','VACWORK','UNKNOWN')),
  location        TEXT,
  work_mode       TEXT CHECK (work_mode IN ('ONSITE','HYBRID','REMOTE')),
  closing_date    TEXT,
  description_raw TEXT,
  requirements_json TEXT,
  content_hash    TEXT,                         -- detect silently-edited reposts
  discovered_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_opp_canonical ON opportunities(url_canonical);
CREATE INDEX idx_opp_closing   ON opportunities(closing_date);
CREATE INDEX idx_opp_dedupe    ON opportunities(organisation, title, type, closing_date);

CREATE TABLE eligibility_assessments (
  id              TEXT PRIMARY KEY,
  opportunity_id  TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  verdict         TEXT NOT NULL CHECK (verdict IN ('ELIGIBLE','NOT_ELIGIBLE','UNCERTAIN')),
  score           REAL,
  criteria_json   TEXT NOT NULL,                -- [{criterion,verdict,evidence,profile_ref}]
  open_questions_json TEXT,
  model           TEXT,
  cost_usd        REAL DEFAULT 0,
  assessed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_elig_opp ON eligibility_assessments(opportunity_id);

CREATE TABLE applications (
  id              TEXT PRIMARY KEY,
  -- THE duplicate guard: one application per opportunity, enforced by the DB.
  opportunity_id  TEXT NOT NULL UNIQUE REFERENCES opportunities(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN
                    ('DISCOVERED','ELIGIBLE','NOT_ELIGIBLE','NEEDS_REVIEW','PREPARING',
                     'IN_PROGRESS','HUMAN_ACTION_REQUIRED','AWAITING_APPROVAL','SUBMITTED',
                     'FAILED','REJECTED','INTERVIEW','OFFER','CLOSED')),
  risk_tier       TEXT NOT NULL DEFAULT 'AMBER' CHECK (risk_tier IN ('GREEN','AMBER','RED')),
  submit_policy   TEXT NOT NULL DEFAULT 'ask'   CHECK (submit_policy IN ('never','ask','auto')),
  site_key        TEXT,
  cv_document_id  TEXT,
  -- Prepare-then-replay: frozen approved payload, replayed with ZERO ai calls.
  replay_payload_json TEXT,
  replay_prepared_at  TEXT,
  approved_at     TEXT,
  approved_by     TEXT,
  started_at      TEXT,
  submitted_at    TEXT,
  confirmation_text TEXT,
  confirmation_screenshot TEXT,
  failure_reason  TEXT,
  cost_usd        REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_app_status ON applications(status);
CREATE INDEX idx_app_tier   ON applications(risk_tier, status);

CREATE TABLE application_steps (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  step_kind       TEXT NOT NULL,                -- NAVIGATE|LOGIN|SNAPSHOT|FILL|UPLOAD|NEXT_PAGE|SUBMIT|VERIFY
  page_url        TEXT,
  state           TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','DONE','BLOCKED','FAILED','SKIPPED')),
  payload_json    TEXT,
  result_json     TEXT,
  error_text      TEXT,
  started_at      TEXT,
  finished_at     TEXT,
  UNIQUE (application_id, seq)
);
CREATE INDEX idx_step_app ON application_steps(application_id, seq);

CREATE TABLE field_fills (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  step_id         TEXT REFERENCES application_steps(id) ON DELETE SET NULL,
  field_ref       TEXT NOT NULL,
  selector        TEXT,
  label_text      TEXT,
  field_kind      TEXT,
  value_written   TEXT,                          -- redacted for HIGH-sensitivity paths
  value_source    TEXT NOT NULL CHECK (value_source IN ('PROFILE','GENERATED','HUMAN','DOCUMENT','DEFAULT')),
  profile_ref     TEXT,
  document_key    TEXT,
  generation_id   TEXT,
  verified_readback INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_fill_app ON field_fills(application_id);

-- The cost-control table. A cache hit makes a repeat application nearly free.
CREATE TABLE site_fieldmaps (
  id              TEXT PRIMARY KEY,
  site_key        TEXT NOT NULL,
  page_signature  TEXT NOT NULL,                 -- hash(sorted label+kind+required)
  mapping_json    TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 0,
  times_used      INTEGER NOT NULL DEFAULT 0,
  times_failed    INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_failure_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site_key, page_signature)
);

CREATE TABLE sites (
  site_key        TEXT PRIMARY KEY,
  host            TEXT NOT NULL,
  adapter         TEXT NOT NULL DEFAULT 'generic',
  discovery_only  INTEGER NOT NULL DEFAULT 0,
  robots_allowed  INTEGER,
  verified_successes INTEGER NOT NULL DEFAULT 0,
  submit_policy   TEXT NOT NULL DEFAULT 'ask' CHECK (submit_policy IN ('never','ask','auto')),
  notes           TEXT,
  last_seen_at    TEXT
);

CREATE TABLE generations (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,                 -- MOTIVATION|ANSWER|CV_BULLET
  question_text   TEXT,
  question_hash   TEXT,
  organisation    TEXT,
  answer_text     TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,                -- profile paths backing every claim
  validator_passed INTEGER NOT NULL DEFAULT 0,
  validator_notes TEXT,
  model           TEXT,
  cost_usd        REAL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_gen_reuse ON generations(question_hash, organisation);

CREATE TABLE documents (
  id              TEXT PRIMARY KEY,
  doc_key         TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  path            TEXT NOT NULL,
  sha256          TEXT,
  size_bytes      INTEGER,
  description     TEXT,
  aliases_json    TEXT,
  applies_to_json TEXT,
  certified       INTEGER,                       -- 1 certified / 0 plain / NULL unknown
  third_party     INTEGER NOT NULL DEFAULT 0,    -- parent/guardian data: never auto-submit
  sensitivity     TEXT NOT NULL DEFAULT 'NORMAL' CHECK (sensitivity IN ('NORMAL','HIGH')),
  version         INTEGER NOT NULL DEFAULT 1,
  valid_from      TEXT,
  valid_until     TEXT,
  verified_by_human INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE human_tasks (
  id              TEXT PRIMARY KEY,
  application_id  TEXT REFERENCES applications(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN
                    ('CAPTCHA','CLOUDFLARE','OTP','MFA','EMAIL_VERIFY','AMBIGUOUS_ELIGIBILITY',
                     'MISSING_DOCUMENT','MISSING_ANSWER','APPROVE_SUBMIT','SUBMIT_UNCERTAIN',
                     'LOGIN_REQUIRED','DOC_DISAMBIGUATION','OTHER')),
  urgency         TEXT NOT NULL DEFAULT 'NORMAL' CHECK (urgency IN ('LOW','NORMAL','URGENT')),
  prompt          TEXT NOT NULL,
  context_json    TEXT,
  screenshot_path TEXT,
  state           TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','RESOLVED','CANCELLED','EXPIRED')),
  resolution_json TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);
CREATE INDEX idx_task_open ON human_tasks(state, urgency, created_at);

CREATE TABLE credentials (
  id              TEXT PRIMARY KEY,
  site_key        TEXT NOT NULL,
  username        TEXT,
  secret_enc      BLOB NOT NULL,                 -- Windows DPAPI, user-scoped
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site_key, username)
);

CREATE TABLE ai_calls (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  application_id  TEXT,
  purpose         TEXT NOT NULL,
  model           TEXT NOT NULL,
  cache_hit       INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER,
  cache_create_tokens INTEGER,
  cache_read_tokens INTEGER,
  output_tokens   INTEGER,
  cost_usd        REAL NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  ok              INTEGER NOT NULL DEFAULT 1,
  error_text      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_day ON ai_calls(created_at);

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,                 -- DISCOVER|EVALUATE|APPLY|REPLAY|DIGEST
  state           TEXT NOT NULL DEFAULT 'RUNNING' CHECK (state IN ('RUNNING','DONE','FAILED','BUDGET_STOPPED')),
  budget_usd      REAL,
  spent_usd       REAL NOT NULL DEFAULT 0,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  summary_json    TEXT
);

CREATE TABLE log_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT,
  application_id  TEXT,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  level           TEXT NOT NULL,
  event           TEXT NOT NULL,
  data_json       TEXT
);
CREATE INDEX idx_log_app ON log_events(application_id, ts);
