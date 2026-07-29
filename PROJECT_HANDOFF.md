# Privacy Review Assistant — Project Handoff

## What this is
A web app that helps product/design generalists (not lawyers) catch privacy
issues in a product flow before it reaches legal review. User describes a
flow (data collected, purpose, third parties, retention) via a structured
wizard or free text; the app grounds findings in real GDPR/CCPA/HIPAA clause
text via the Anthropic API, citing the specific clause, and says "not clearly
covered" instead of guessing when nothing applies. A human reviews every
finding (accept/dismiss), and dismissals require a reason from a fixed list,
rolling up into a review log that surfaces dismissal patterns.

Origin: portfolio project by Aman Rawat (UX designer, MS UX Research &
Design, University of Michigan), demonstrating HITL design for probabilistic
systems. Built on top of a Figma Make-generated React scaffold.

## Core design decisions (locked, don't relitigate without reason)
- **Persona**: single primary persona — product/design generalist, privacy-
  literate but not a lawyer. Not building for compliance pros (OneTrust etc.
  already serve them).
- **Finding taxonomy**: mapped to LINDDUN threat categories (unawareness,
  non-compliance, disclosure, linkability, detectability), not invented from
  scratch.
- **Input model**: structured wizard (4 steps: data collected → purpose →
  third parties → retention) AND free text, both routing into one shared
  data shape before anything downstream runs. Free text goes through an
  LLM extraction step first, with a "Reading this as:" confirmation preview
  showing exact source-text highlights for each extracted field (extraction
  can be confidently wrong — this is the mitigation, not perfect accuracy).
- **Regulation scope** (deliberately narrow, not full regulations):
  - GDPR: Art. 6-7 (lawfulness/consent), Art. 12-22 (transparency + all data
    subject rights)
  - CCPA: § 1798.100 (notice at collection), § 1798.120 (opt-out of sale/share)
  - HIPAA: § 164.502(a) (general disclosure rule), § 164.502(b)/164.514(d)
    (minimum necessary)
  - Explicitly OUT of scope: enforcement mechanics, cross-border transfer
    machinery, breach-notification procedure.
- **Finding states** (3 real variants of one component, not separate designs):
  - `grounded` — clause clearly applies, red-tinted badge, citation shown
    inline (never behind a click).
  - `low-confidence` — clause plausibly applies but ambiguous, amber tint.
  - `not-covered` — nothing in corpus matches, neutral gray, NO accept/dismiss
    controls — only a "Send to legal" action, since there's no claim to
    accept or reject.
  - `error` (added later) — the API call itself failed. Must look distinct
    from `not-covered` — dashed gray border, no action buttons at all, just
    an explanatory note. Do not conflate this with `not-covered` again.
- **The variant is NOT chosen by the model.** The model returns a `confidence`
  number 0-1; `src/lib/confidence.ts` owns the cutoffs (`GROUNDED_THRESHOLD`
  0.75, `LOW_CONFIDENCE_THRESHOLD` 0.40) and derives the variant from it. This
  keeps a product decision — how much caution a non-lawyer is owed — in product
  code where it can be versioned and tuned, rather than inside a prompt.
  Thresholds are asymmetric on purpose: a false "grounded" tells a generalist
  to act, so that bar sits high.
  - **Demotion rule**: a finding whose `clause_id` doesn't resolve against the
    corpus is forced to `not-covered` no matter how confident the model was,
    because the promise of the grounded badge is a citation displayed inline.
    Demotions are shown to the user, never silent.
- **Dismiss flow**: requires picking a reason immediately (not-clause-
  relevant / false-positive / already-handled) from a fixed list, no free
  text — this is what lets the review log detect patterns later.
- **Review log**: auto-generates a pattern-insight callout, e.g. "N of M
  dismissals on [clause] were marked [reason]" — this is the evaluation
  mechanism, not just an audit trail.

## Architecture
- Vite + React (TypeScript), single monolithic `src/app/App.tsx` (~1100
  lines) — screens are managed via useState, no react-router despite it
  being a dependency (unused).
- `src/lib/corpus.ts` — the actual clause corpus (17 clauses: 13 GDPR, 2
  CCPA, 2 HIPAA), real statutory text pulled from gdpr-info.eu /
  privacy-regulation.eu / California Civil Code / eCFR. Treat as a snapshot,
  not a live legal source. Every clause carries `taxonomy_tags` mapping it to
  LINDDUN categories — these were dead metadata until the retrieval stage
  started using them.
- `src/lib/retrieval.ts` — **the retrieval stage** (added after the original
  build). Scores all 17 clauses against a step's input and sends only the top
  `DEFAULT_K` (currently 8) to the model. Four signals: IDF-weighted term
  overlap, a domain lexicon mapping product vocabulary to LINDDUN tags,
  per-clause synonyms, and step tag priors. Plus `STEP_PINNED_CLAUSES` for
  obligations that apply regardless of wording (notice at collection, lawful
  basis) — those are pinned rather than left to lexical scoring.
  - **This deliberately introduces a failure mode**: a clause that doesn't rank
    never reaches the model and cannot be cited. That is what makes the
    "not clause-relevant" dismissal reason meaningful, and it is why the
    candidate set and near-misses are exposed in the UI. Do not remove the
    `RetrievalDisclosure` component — an invisible retrieval miss is the exact
    thing this design is trying not to have.
- `src/lib/confidence.ts` — threshold constants and `classify()`. See the
  finding-states note above.
- `src/lib/evalset.ts` — 16 labelled evaluation cases plus `runRetrievalEval()`
  and `recallCurve()`. Deterministic and client-side, so it costs no API calls
  and runs on every load of the Evaluation screen. **Re-run it after any change
  to retrieval scoring** — `DEFAULT_K` is only correct for the weights it was
  measured against.
- `src/lib/anthropicClient.ts` — frontend client, calls `/api/claude` (NOT
  Anthropic directly — key must never be in browser code).
- `api/claude.ts` — Vercel serverless function, holds `ANTHROPIC_API_KEY`
  server-side, proxies to Anthropic's `/v1/messages`, model
  `claude-sonnet-4-6`.
- `netlify/functions/claude.js` + `netlify.toml` — Netlify-equivalent proxy,
  same `/api/claude` path via redirect, so frontend code doesn't care which
  platform is used. Currently deploying to **Vercel** (not Netlify).
- Two LLM call types: `generateFindingsLLM` (retrieval → candidate clauses →
  findings) and `extractFieldsLLM` (free-text → structured fields with
  source quotes for highlighting). These are the ONLY probabilistic parts of
  the app. Citation text, sensitive-data warnings, the review-log insight, and
  the whole evaluation harness are deterministic code.
- Four screens, not three: New review, Review log, Corpus, and **Evaluation**
  (added with the retrieval stage — shows live recall, the recall-by-K curve,
  and every failing case).
- `README.deploy.md` has full Vercel/Netlify deployment steps.

## Current deployment state
- Live on Vercel, project name `privacy-review-assistant`, connected to a
  GitHub repo (files uploaded via GitHub web UI, not git CLI).
- `ANTHROPIC_API_KEY` env var is set in Vercel (Production + Preview).
- User has been manually re-uploading changed files to GitHub via drag-and-
  drop through the web UI (not comfortable with git CLI) — expect this
  pattern to continue unless Claude Code sets up proper git.

## Bugs found and fixed so far, in order
1. Findings/extraction were originally hardcoded rule-based logic (from
   Figma Make) — replaced with real LLM calls grounded in the corpus. Fixed.
2. Corpus only had 3 GDPR articles initially — expanded to full locked scope
   (17 clauses). Fixed.
3. Client-side API key (`VITE_ANTHROPIC_API_KEY`) — insecure for public
   deployment, exposed in browser bundle. Replaced with server-side proxy
   architecture (`api/claude.ts` / Netlify function). Fixed.
4. Error state reused the `not-covered` variant, showing "Send to legal" and
   allowing Accept on a failed API call. Added distinct `error` variant with
   no action buttons. Fixed.
5. Server-side "message too long" guard was capped at 6000 chars, but the
   corpus block alone (embedded in every findings request) exceeds that now
   that it's 17 clauses. Raised cap to 24000. Fixed.
6. Wizard forced non-empty input on steps 2-4 (purpose/third-parties/
   retention) to advance, even though a real flow can legitimately have none
   of these (no third-party sharing, retention undecided, etc.), and the
   findings logic already handles empty fields correctly. Relaxed `canNext`
   to only require step 1 (data collected). Fixed.

7. `[object Object]` shown instead of the real error. Anthropic's error shape is
   `{ error: { type, message } }` and the parsing code did `String(errBody.error)`
   on the whole object. A previous session recorded this as fixed; it was not —
   the edit had never been written to the file. Now genuinely fixed in
   `src/lib/anthropicClient.ts` via a `readErrorMessage()` helper that handles
   both shapes (our proxy returns a string in `error`, Anthropic returns an
   object) and appends the HTTP status and Anthropic's error `type`. Fixed.

## ROOT CAUSE OF THE LIVE FAILURE — resolved
Once the error surfaced properly, the message was:

> Your credit balance is too low to access the Anthropic API.

The API key is **valid** — a direct `curl` against `/v1/messages` returned
`invalid_request_error` about the balance, not `authentication_error`. So the
Vercel function, the env var, the proxy, and the model string were all fine
the whole time.

Ruled out along the way, so nobody re-investigates them:
- **Model string** — `claude-sonnet-4-6` is a real, current model. Not the bug.
- **Message-too-long guard** — the real request measured ~16,255 chars against
  the 24,000 cap (and is smaller now that retrieval trimmed it). Not the bug.
- **CORS** — the browser calls `/api/claude` on the same Vercel domain, so CORS
  never applied. Not the bug.

**Remaining blocker is not a code problem.** Two user actions:
1. Purchase credits at console.anthropic.com → Plans & Billing (~$5 covers
   roughly 86 full reviews at current cost). Leave auto-reload OFF — the
   `/api/claude` endpoint is public and unauthenticated, so the credit balance
   is effectively the exposure ceiling.
2. Upload the changed files to GitHub and let Vercel redeploy.

**Nothing in this project has been verified end-to-end against the live API
yet.** Retrieval, the confidence thresholds, and the evaluation harness were
all tested directly in Node (retrieval is deterministic, so it can be), but the
model call path is unproven.

## Retrieval evaluation — current numbers
Measured by `runRetrievalEval()`, visible on the Evaluation screen.

| Change | Recall @ K=6 |
|---|---|
| Term overlap + lexicon + step priors (first version) | 66.7% |
| \+ per-clause synonyms | 79.2% |
| \+ pinned unconditional clauses | 95.8% |

At the shipped `K=8`, recall is **100% (24/24 expected clauses, 16/16 cases)**.

**Treat that 100% with suspicion.** The 16 cases were written first and the
scoring was then tuned until they passed. That is what an eval set is for, but
it measures fit to one author's labels, not generalisation. The honest next
step is held-out cases written *after* the tuning. Labels are a designer's
reading of the clauses, not legal ground truth. This caveat is also printed on
the Evaluation screen — keep it there.

Cost effect of retrieval: input dropped from ~19,500 to ~11,200 tokens per full
review (43% less), about $0.058 per review, ~86 reviews per $5.

## Not yet done
- Full end-to-end verified test with real findings (blocked on credits)
- Review log pattern-insight callout has never been exercised with real
  dismissal data. To trigger it you need 3+ dismissals total AND 2+ on the
  *same* citation marked "not clause-relevant" (`computeInsight`, App.tsx).
- Free text mode has never been tested against the live API
- **Held-out evaluation cases** — see the caveat above
- **Nothing persists.** All state is in-memory React state; a page refresh
  destroys the review log. This is the main gap between the "auditable" claim
  and what is actually built. `localStorage` for `dismissed` is ~15 lines.
- **No timestamps on findings**, no reviewer identity, and only *dismissed*
  findings reach the log — accepted ones are never recorded anywhere. An
  auditor could see what was rejected but not what was approved.
- **"Send to legal" is recorded as `accepted`** (`handleSendToLegal`), so an
  escalation leaves no distinguishable trace. Needs its own status.
- **Accessibility — first pass done, not audited with real AT.** See the section
  below for what was covered and what wasn't.
- Free-text extraction fires on an 800ms debounce, so a paragraph typed with
  natural pauses can trigger 5-15 extraction calls (~$0.006 each).
- Case study writeup (outline was discussed, not drafted): problem/thesis →
  persona decision → LINDDUN framework choice → key design decisions →
  the "confidently wrong" extraction problem (strongest section) →
  evaluation approach → open questions
- No automated tests exist at all
- Figma design system (tokens, components) was discussed conceptually but
  not built as actual Figma files — only chat-based mockups were created

## Accessibility and responsive layout

**Contrast.** Four measured AA failures found and fixed. Ratios were computed,
not eyeballed — re-measure rather than guess if these colours change:

| Element | Before | After |
|---|---|---|
| `--muted-foreground` on background | 4.48:1 ✗ | 4.89:1 (token darkened to `#6B6B74`) |
| Error badge (`gray-400`) | 2.54:1 ✗ | 7.56:1 (`gray-600`) |
| `not-covered` badge on `gray-100` | 4.39:1 ✗ | 6.87:1 (`gray-600`) |
| "Accepted" label (`green-600`) | 3.30:1 ✗ | 5.02:1 (`green-700`) |

**Colour is no longer the only signal (1.4.1).** Finding variants were
distinguished purely by tint. Each badge now carries a visually-hidden
`VARIANT_LABEL` ("Clause clearly applies", "Clause may apply, unconfirmed", …),
and toggle/filter buttons expose `aria-pressed` rather than relying on
background colour alone.

**Dismiss modal** was the worst offender — it had no dialog semantics at all.
Now: `role="dialog"` + `aria-modal` + `aria-labelledby`, focus moved in on open
and **restored to the trigger on close**, Tab cycled inside the dialog, Escape
closes, and the reason list is a `radiogroup`.

**Also added:** a skip link, `aria-current="page"` on nav, `aria-live` regions
for async findings and extraction status (they previously appeared silently),
`aria-label` on icon-only buttons, `aria-hidden` on decorative icons, `scope`
and a `<caption>` on the review-log table, and `focus-visible` rings on inputs
whose `outline-none` had removed the focus indicator entirely (2.4.7).

**Responsive.** The layout now inverts at `md`: below it the app is a normal
scrolling page with a horizontal nav bar and stacked panes; at `md` and up it
is the original fixed-height two-column shell. The `h-screen` +
`overflow-hidden` + `w-[52%]` combination is what made it desktop-only.

**What this pass does NOT cover — do not claim these:**
- No testing with an actual screen reader (VoiceOver/NVDA). Everything above is
  correct-by-construction, which is not the same as verified.
- No automated audit (axe, Lighthouse) has been run.
- The dismiss radiogroup is Tab+Enter operable but has no arrow-key roving
  focus. That satisfies WCAG 2.1.1 but deviates from the ARIA authoring
  practice for radiogroups.
- Dark-mode tokens in `theme.css` were not re-measured; only the light theme was.
- Zoom/reflow at 400% (1.4.10) untested.

## User context (communication style)
Aman is a UX designer, not a developer — comfortable with product/design
reasoning and Figma, but new to git, terminal, and deployment mechanics.
Has been walked through git-free workflows (GitHub web upload UI, Vercel
dashboard clicks) rather than CLI. If continuing in Claude Code, consider
whether to set up proper git locally for him now that the project is more
complex, but explain any CLI steps in plain, step-by-step terms as this
conversation did.
