# Privacy Review Assistant

A pre-legal screening tool that checks a product flow against the actual text of
GDPR, CCPA, and HIPAA — and is designed around the assumption that it will
sometimes be wrong.

**Live demo:** _add your Vercel URL here_

---

## The problem

A product manager or designer shipping a signup flow has to decide whether it
raises privacy issues worth escalating. They are privacy-literate but not
lawyers. Existing compliance tooling is built for compliance professionals, so
in practice the decision gets made from memory, or skipped, and surfaces six
weeks later in legal review.

An LLM will happily answer this question. That is the problem, not the solution.
A generalist cannot tell a correct answer from a confidently wrong one, and
neither can the legal team reading it later.

So the design question is not "can a model find privacy issues" — it can. It is:

> **How do you build an interface around a probabilistic system that a
> non-expert can calibrate their trust against, and an expert can check?**

Every decision below is an answer to that question.

---

## What it does

Describe a product flow — either through a four-step wizard (data collected →
purpose → third parties → retention) or as free text — and the app returns
findings, each tied to a specific clause.

**Four screens:**

| Screen | Purpose |
|---|---|
| **New review** | Input on the left, findings on the right, appearing as you go |
| **Review log** | Dismissed findings with their reasons, plus an auto-generated pattern insight |
| **Corpus** | The complete list of clauses that can be cited — nothing else can be |
| **Evaluation** | Live retrieval accuracy, measured against a labelled set |

---

## How it works

```
flow input
    │
    ├─▶ retrieval          score 17 clauses, send the top 8
    │                      (deterministic, src/lib/retrieval.ts)
    │
    ├─▶ generation         Claude judges only those candidates,
    │                      returns a clause id + a confidence number
    │
    ├─▶ verification       clause id resolved against the local corpus;
    │                      citation text comes from our data, never the model
    │
    └─▶ classification     confidence mapped to a variant by thresholds
                           we own (src/lib/confidence.ts)
```

**The model makes exactly two judgements** — which clause applies and how
confident it is, plus parsing free text into fields. Everything a user relies
on is deterministic code: the citation text, the sensitive-data warnings, the
review-log insight, and the entire evaluation harness.

Keeping the probabilistic surface small and wrapping it in checks is the point.

---

## Design decisions

**A bounded, visible corpus.** 17 clauses — 13 GDPR articles, 2 CCPA sections,
2 HIPAA provisions — scoped to what a generalist actually meets. Enforcement
mechanics, cross-border transfer machinery, and breach notification are
deliberately excluded; that is compliance-professional territory. The Corpus
screen shows users the complete universe of what can be cited, so the tool's
limits are legible rather than implied.

**Citations are looked up, not generated.** The model returns only a clause
`id`. The citation text you see is resolved from the local corpus. A model that
invents an id produces *no citation* rather than a convincing fake one — which
makes that particular failure structurally impossible instead of merely
unlikely.

**Abstention is a designed state, not an error path.** When nothing applies, the
result is `not-covered`: neutral styling, no Accept or Dismiss button, and a
single "Send to legal" action. There is no claim to accept or reject, so the
interface does not offer the gesture. Chat interfaces are structurally biased
toward producing output; this is a place to say nothing.

**Thresholds live in product code.** The model reports a confidence number; the
cutoffs between "clearly applies", "may apply", and "no claim made" are
constants in `src/lib/confidence.ts`. Where caution begins is a product decision
about what a non-lawyer is owed — the model has no view on that. They are
asymmetric on purpose: a false "grounded" tells someone to act, so that bar sits
high. A finding whose clause fails to resolve is demoted regardless of
confidence, because the promise of that badge is a citation displayed inline.

**Retrieval is inspectable, including its misses.** Sending only the top 8
clauses introduces a real failure mode: a clause that does not rank cannot be
cited, however relevant it was. So each finding group exposes what was retrieved,
each clause's score and why it scored, and — importantly — the near-misses that
ranked just below the cutoff. A retrieval miss you can point at is worth more
than a silent one.

**Dismissals are structured, and become evaluation data.** Dismissing requires
picking from a fixed list (not clause-relevant / false positive / already
handled), with no free-text option. That constraint is what lets the review log
detect that four of five dismissals on one clause were "not clause-relevant" —
a signal that retrieval is over-ranking it. Ordinary use produces a feedback
signal about the system itself. A chat session never does.

**Extraction shows its work.** Free-text parsing can be confidently wrong, so the
"Reading this as" panel highlights the exact source words behind each extracted
field. The mitigation is visibility, not accuracy.

---

## Evaluation

Retrieval decides what the model is even allowed to consider, so it governs
whether the pipeline can be correct at all. `src/lib/evalset.ts` holds 16
labelled cases; the Evaluation screen scores them live, client-side, with no API
calls.

| Change | Recall @ K=6 |
|---|---|
| Term overlap + lexicon + step priors | 66.7% |
| \+ per-clause synonyms | 79.2% |
| \+ pinning unconditional obligations | 95.8% |

At the shipped **K=8**, recall is **100%** (24/24 clauses, 16/16 cases), and `K`
was chosen from the recall curve rather than by intuition — 8 is where the gain
flattens.

Each fix came from a specific failure. Synonyms addressed a vocabulary gap:
users write "corrections" and "CSV export" where the statute says
"rectification" and "portability", so term overlap found nothing. Pinning
addressed a different problem — obligations like notice-at-collection apply
whether or not the description happens to contain the word "notice", so lexical
scoring should never have been deciding them.

**Read the 100% cautiously.** The cases were written first and the scoring was
then tuned until they passed. That is what an evaluation set is for, but it
measures fit to one author's labels, not generalisation. Held-out cases written
after the tuning are the honest next step. Labels are a designer's reading of
the clauses, not legal ground truth.

---

## Known limitations

Stated plainly because a tool about calibrated trust should be calibrated about
itself.

- **Nothing persists.** All state is in-memory; a page refresh destroys the
  review log. This is the main gap between the auditability the design argues
  for and what is actually built.
- **The log records only dismissals.** Accepted findings and escalations to
  legal leave no trace, and findings carry no timestamp or reviewer identity.
- **No user research.** No interviews, no usability testing, no participants.
  The design reasoning is argued, not validated.
- **The corpus is a snapshot**, hand-assembled from public sources, not a
  live-updating legal database.
- **Accessibility is a considered pass, not an audited one.** Contrast failures
  were measured and fixed and the dialog has proper focus management, but
  nothing has been tested with a real screen reader.
- **The API endpoint is public and unauthenticated.** There is an input-length
  cap but no rate limiting — see [README.deploy.md](README.deploy.md).

---

## Running it

```bash
npm install
npm run dev
```

The findings and extraction calls need a server-side function holding an
Anthropic API key, so `npm run dev` alone will show the UI with those calls
failing. For the full app locally, use `vercel dev` or `netlify dev` — see
[README.deploy.md](README.deploy.md) for setup and the key-handling rationale.

**The Evaluation screen works with no API key at all**, because retrieval is
deterministic.

## Project structure

```
src/lib/corpus.ts       17 clauses, with LINDDUN taxonomy tags
src/lib/retrieval.ts    scoring, K selection, pinned clauses
src/lib/confidence.ts   thresholds and the demotion rule
src/lib/evalset.ts      labelled cases and recall scoring
src/lib/anthropicClient.ts  calls /api/claude, never Anthropic directly
api/claude.ts           serverless proxy holding the API key
src/app/App.tsx         all four screens
```

**Stack:** Vite, React, TypeScript, Tailwind. Findings are generated with the
Anthropic API. Finding categories map to
[LINDDUN](https://linddun.org/) threat categories rather than an invented
taxonomy.

---

## Disclaimer

This is a portfolio project demonstrating human-in-the-loop design for
probabilistic systems. It is **not legal advice and not a compliance product**.
The corpus is a small, hand-picked subset of three regulations. Verify anything
here against primary sources and a qualified professional.

Built by [Aman Rawat](https://amanrawat.framer.website/).
