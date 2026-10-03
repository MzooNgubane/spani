# Spani

A local agent that finds bursary, internship and graduate-programme openings,
checks whether you actually qualify, fills in the application, attaches the
right documents, and stops before it does anything it shouldn't.

Built for South African applications, where one person typically applies to
dozens of schemes with the same twelve documents and the same forty answers.

Everything runs on your own machine. Nothing about you is uploaded anywhere
except to the application you are deliberately submitting.

---

## The problem

Applying for funding is not hard, it is repetitive and unforgiving. The same
ID number, the same matric results, the same motivation letter, thirty times.
And the failure modes are silent: you attach the uncertified ID instead of the
certified one, or a proof of residence that expired last month, and you simply
never hear back.

So the hard part of automating it is not filling the form. It is **not getting
anything wrong**, and **knowing when to stop**.

---

## How it works

```
  opportunity URL
        │
        ▼
  ┌───────────────┐   Claude extracts the requirements from the advert.
  │  ELIGIBILITY  │   TypeScript compares them to your stored facts.
  └───────┬───────┘   ELIGIBLE / NOT_ELIGIBLE / UNCERTAIN, with reasons.
          │
          ▼
  ┌───────────────┐   Walks the DOM, emits ~1KB of form structure.
  │   SNAPSHOT    │   Never sends raw HTML - that would cost 50x more.
  └───────┬───────┘
          │
          ▼
  ┌───────────────┐   Claude maps each field to a profile path.
  │   FIELDMAP    │   Cached per form, so the next application is free.
  └───────┬───────┘
          │
          ▼
  ┌───────────────┐   Deterministic. Reads every value back to confirm it.
  │     FILL      │   Picks documents by meaning, not filename.
  └───────┬───────┘
          │
          ▼
  ┌───────────────┐   Freezes the payload, then stops at the submit button.
  │  SUBMIT GATE  │   You approve. Replay is deterministic, zero AI calls.
  └───────────────┘
```

### Claude is the reasoning layer, not the driver

The model never touches the browser and never produces a value that goes into
a form. It may return exactly three things:

- a **profile path** — "this field wants `education.current.institution`"
- a request to **write prose** from cited facts
- an **escalation** — "a human must decide this"

Deterministic code resolves paths to values and types them in. That is what
structurally prevents a hallucinated ID number, employer or grade from reaching
a real application.

### Costs are measured, not guessed

Reasoning goes through the Claude Code CLI in headless mode, so it draws on a
Claude **subscription** rather than metered API credits. Measured on a 30-field
bursary form (notional list-price equivalents, used as a rate-limit gauge):

| | cost |
|---|---|
| first visit to a form | $0.053 |
| **second visit (fieldmap cached)** | **$0.000** |
| one fact-checked written answer | ~$0.03–0.06 |

The cache is what makes this viable on an entry-level plan. Prompt-cache TTL is
one hour, so the agent runs as one sustained nightly batch rather than
scattered calls, and stops cleanly at a configurable spend cap.

---

## What stops it doing damage

These are enforced in code and covered by tests, not left to the model's
judgement.

**It cannot invent anything.** Generated prose must cite profile paths, and is
then checked for numbers, entities, seniority claims and fabricated employment
that do not appear in your profile. Two failures and it becomes a question for
you, not a submission.

**`null` means UNKNOWN, never "no".** A profile field that isn't set always
escalates. Collapsing unknown into false is how an agent ends up telling an
employer you have a licence you don't have.

**Sensitive values never reach the model.** Claude receives the dot-path
`personal.id_number`; code substitutes the digits. The ID number is not in any
prompt, any log, or any stored field value.

**Documents are matched by meaning and gated.** "Upload a certified copy of
your ID" resolves to the certified file, not the plain one. Nothing uploads
until a human has verified that manifest entry. Expired documents are refused.
Password-protected files are refused. Third-party documents — a parent's ID or
bank statement — never upload without explicit approval.

**A false NOT_ELIGIBLE is treated as the worst error.** It discards an
opportunity silently and nobody ever finds out. So `FAIL` requires a closed set
of acceptable values; a vague requirement becomes a question instead.

**It never defeats a security control.** CAPTCHA, Cloudflare, OTP, MFA and
payment fields are detected, not solved. The agent pauses, raises the window,
says exactly what is needed — and then watches for completion and **resumes by
itself**. One CAPTCHA in a twenty-step application should cost ten seconds, not
the other nineteen steps.

**It cannot apply twice.** One application per opportunity is a `UNIQUE`
constraint. A submit interrupted mid-flight is never retried automatically; it
becomes a question, because filling a field twice is harmless and submitting
twice is not.

---

## What it does not do

Worth being straight about, because the gap between this and "fully autonomous"
is real:

- **It will not run completely unattended.** Submitting in your name needs a
  permission you grant deliberately. Some portals need a one-time manual login.
  Some require a form commissioned in person. Realistically this turns hours of
  work into minutes, not into zero.
- **Some sites will refuse it.** Enterprise bot management increasingly
  challenges automation before a form even renders. Since nothing here spoofs
  or evades, those sites simply won't work.
- **LinkedIn and Indeed are discovery-only.** Automated applying there risks the
  account, which is worth more than the automation.
- **Broad opportunity discovery is deliberately last.** A curated list of real
  funders beats a scraper returning mostly-closed listings.

---

## Stack

TypeScript on Node 22, Playwright driving real Chrome with a persistent profile
so logins survive between runs, SQLite for state, and a dependency-free local
dashboard bound to localhost. No paid services, no cloud, no external database.

```
src/core         config, redacting logger, sqlite + migrations
src/ai           Claude CLI bridge, schema validation, cost meter, budget caps
src/profile      profile schema, dot-path resolver, sensitivity rules
src/documents    manifest, deterministic document matcher
src/browser      persistent session, semantic snapshot, verification detector
src/engine       fieldmap + cache, filler, answer generator, step journal
src/eligibility  requirement extraction and deterministic comparison
src/hitl         human-task broker, notifier, resume watcher
src/server       local dashboard
fixtures/        local HTML forms, so development never hits a real employer
```

## Getting started

**Requirements:** Node 22+, Google Chrome, and
[Claude Code](https://claude.com/claude-code) installed and signed in — the
agent shells out to it for reasoning, which is what keeps this on a
subscription rather than metered API credits. No API key needed; if you have
`ANTHROPIC_API_KEY` set, the agent strips it from the child process so you
don't silently start paying per token.

```bash
git clone https://github.com/MzooNgubane/spani
cd spani
npm install
npm run spani -- init     # writes starter files; never overwrites yours
npm run doctor            # checks the stack and does a live Claude round-trip
```

`init` creates `data/` with a commented profile template, a document manifest
template and a config file. Then:

1. **Fill in `data/profile/master.yaml`.** The comments explain the rules at
   the point you're typing. The one that matters: `null` means UNKNOWN and
   always escalates to you; `false` means a confirmed no. Don't conflate them.
2. **Copy your documents** into `data/documents/<category>/`.
3. **Describe them in `data/documents/manifest.yaml`** — what each file is,
   whether it's certified, when it expires, and the phrases a form might use
   for it. There's a worked example to copy.
4. `npm run spani -- ingest` to load them.
5. `npm run spani -- review` lists what's still missing, sorted by what
   actually blocks applications rather than every empty field.
6. Set `meta.verified_by_human: true` once you've read your profile through.
   Nothing is submitted while it's false.

Everything in `data/` is gitignored in full. This repository contains no
personal data; the test fixtures use a fictional applicant.

## Usage

```bash
npm run spani -- add <url>      # take in an opportunity, assess eligibility
npm run spani -- queue          # what it would work on next
npm run spani -- dry-run <url>  # full pipeline, nothing typed, nothing sent
npm run spani -- apply <url>    # drive it, stopping at the submit button
npm run spani -- dashboard      # http://127.0.0.1:4317
npm run spani -- nightly        # the unattended run
npm test                        # 82 tests
```

Start with `dry-run` against `fixtures/01-bursary-simple.html` — it exercises
the whole pipeline against a local form, so you can see what it would do
without touching anyone's real application.

To run it unattended, `scripts/install-schedule.ps1` registers a nightly task
on Windows. It runs as one sustained batch at 02:00, because the prompt cache
has a one-hour TTL and a warm cache is far cheaper than scattered calls. It
needs an interactive desktop session for the headed browser; a locked screen
is fine, a logged-off one isn't.

## Status

Working and tested end to end against local fixtures, and partially against a
live portal. The engine, eligibility checks, document handling and safety rails
are done. Opportunity discovery, CV tailoring and site-specific adapters are
not.

## Licence

MIT
