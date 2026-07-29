// Evaluation set for the retrieval stage.
//
// Retrieval only sends the top K clauses to the model. Anything that doesn't
// rank cannot be cited, no matter how relevant it is — so "did the right clause
// survive retrieval?" is the question that governs whether the whole pipeline
// can possibly be correct. A model can only work with what it was handed.
//
// This file is the labelled set that answers it. Each case is a realistic flow
// description plus the clause ids a competent reviewer would expect to be in
// play. Recall over this set is what K, the scoring weights, and the tag
// lexicon in retrieval.ts should be tuned against.
//
// Two deliberate choices:
//
//  * It runs entirely client-side. Retrieval is deterministic, so measuring it
//    costs no API calls. That means the eval can run on every load, in the
//    browser, for free — and stays run rather than becoming a script nobody
//    executes.
//
//  * Some cases are expected to fail. A set where everything passes is either
//    trivial or was written after seeing the results. The failures are the
//    useful part: they are the backlog.
//
// Labels are the author's judgement, not a legal ground truth — this is a
// portfolio evaluation harness, not a compliance benchmark. The value is in
// having a fixed target that changes to scoring can be measured against, so a
// tuning change that helps one input and quietly breaks four others shows up.

import { retrieveClauses, DEFAULT_K } from "./retrieval";
import { CORPUS } from "./corpus";

export interface EvalCase {
  id: string;
  step: 1 | 2 | 3 | 4;
  input: string;
  /** Clause ids that should survive retrieval for this input. */
  expected: string[];
  /** Why these clauses — the reasoning behind the label. */
  rationale: string;
}

export const EVAL_CASES: EvalCase[] = [
  // ── Step 1: data collected ────────────────────────────────────────────────
  {
    id: "s1-basic-account",
    step: 1,
    input: "Data types collected: email address, full name, browsing history, purchase history",
    expected: ["gdpr-art6", "ccpa-1798.100"],
    rationale: "Any collection needs a lawful basis, and CCPA requires notice at the point of collection.",
  },
  {
    id: "s1-health",
    step: 1,
    input: "Data types collected: patient diagnosis codes, treatment notes, insurance member ID",
    expected: ["hipaa-164.502a", "hipaa-164.502b"],
    rationale: "Protected health information triggers the HIPAA disclosure rule and minimum necessary.",
  },
  {
    id: "s1-identifiers",
    step: 1,
    input: "Data types collected: device fingerprint, cross-app advertising identifier, inferred household income",
    expected: ["gdpr-art6", "gdpr-art13"],
    rationale: "Inferred and cross-device identifiers still need a basis and disclosure at collection.",
  },
  {
    id: "s1-sensitive-mixed",
    step: 1,
    input: "Data types collected: religious affiliation, dietary restrictions, emergency contact",
    expected: ["gdpr-art6", "gdpr-art7"],
    rationale: "Special-category data raises the bar on legal basis and on the quality of consent.",
  },

  // ── Step 2: purpose ───────────────────────────────────────────────────────
  {
    id: "s2-undisclosed-personalisation",
    step: 2,
    input: "Stated purpose: To personalise advertising using purchase history. Users are not told this happens.",
    expected: ["gdpr-art13", "gdpr-art6"],
    rationale: "Undisclosed secondary use is an Art. 13 information failure before it is anything else.",
  },
  {
    id: "s2-automated-decision",
    step: 2,
    input: "Stated purpose: To automatically decline loan applications using a credit scoring model, with no human review of the decision.",
    expected: ["gdpr-art22"],
    rationale: "Solely automated decisions with legal or significant effects are exactly Art. 22.",
  },
  {
    id: "s2-marketing-scope-creep",
    step: 2,
    input: "Stated purpose: To send marketing emails to everyone who signed up for the free trial.",
    expected: ["gdpr-art6", "gdpr-art21"],
    rationale: "Repurposing trial signups for marketing needs a basis and a route to object.",
  },
  {
    id: "s2-rectification",
    step: 2,
    input: "Stated purpose: To maintain accurate shipping records; users can request corrections to a wrong address.",
    expected: ["gdpr-art16"],
    rationale: "A correction workflow is the Art. 16 right to rectification.",
  },

  // ── Step 3: third parties ─────────────────────────────────────────────────
  {
    id: "s3-adtech-stack",
    step: 3,
    input: "Third parties data is shared with: Stripe for payments, Google Analytics for usage, Meta Pixel for ad attribution",
    expected: ["ccpa-1798.120", "gdpr-art13"],
    rationale: "Ad-tech sharing is a CCPA sale/share opt-out trigger and a disclosure duty under GDPR.",
  },
  {
    id: "s3-data-broker",
    step: 3,
    input: "Third parties data is shared with: we sell aggregated customer lists to data brokers for revenue",
    expected: ["ccpa-1798.120"],
    rationale: "Selling personal information is the core § 1798.120 opt-out case.",
  },
  {
    id: "s3-hipaa-vendor",
    step: 3,
    input: "Third parties data is shared with: an external billing contractor who receives full patient records",
    expected: ["hipaa-164.502a", "hipaa-164.502b"],
    rationale: "Disclosure of PHI to a business associate, and sending full records fails minimum necessary.",
  },
  {
    id: "s3-none",
    step: 3,
    input: "Third parties data is shared with: nobody, all processing happens on our own infrastructure",
    expected: [],
    rationale: "Control case — no sharing means no disclosure clause should dominate. Tests over-triggering.",
  },

  // ── Step 4: retention ─────────────────────────────────────────────────────
  {
    id: "s4-standard-retention",
    step: 4,
    input: "Retention description: Account data is kept for 3 years after last login, then deleted. Users can request deletion earlier.",
    expected: ["gdpr-art17"],
    rationale: "A deletion-on-request workflow is the Art. 17 right to erasure.",
  },
  {
    id: "s4-indefinite-logs",
    step: 4,
    input: "Retention description: Server logs containing IP addresses are kept indefinitely and never deleted.",
    expected: ["gdpr-art17", "gdpr-art13"],
    rationale: "Indefinite retention conflicts with erasure and with the duty to state a retention period.",
  },
  {
    id: "s4-export",
    step: 4,
    input: "Retention description: Before deletion, users can download everything we hold on them as a CSV export.",
    expected: ["gdpr-art20"],
    rationale: "A machine-readable export is the Art. 20 portability right.",
  },
  {
    id: "s4-undecided",
    step: 4,
    input: "Retention description: We have not decided a retention period yet.",
    expected: ["gdpr-art13"],
    rationale: "No retention period still has to be disclosed — Art. 13(2)(a) requires the period or the criteria.",
  },
];

export interface CaseResult {
  evalCase: EvalCase;
  /** Expected clauses that survived retrieval. */
  found: string[];
  /** Expected clauses that did not — the retrieval misses. */
  missed: { clauseId: string; label: string; actualRank: number | null }[];
  /** All expected clauses retrieved. */
  passed: boolean;
  retrievedCount: number;
}

export interface EvalSummary {
  k: number;
  cases: CaseResult[];
  /** Cases where every expected clause survived. */
  casesPassed: number;
  casesTotal: number;
  /** Expected clauses found / expected clauses total, across the whole set. */
  recall: number;
  expectedFound: number;
  expectedTotal: number;
}

const labelFor = (clauseId: string): string => {
  const c = CORPUS.find(x => x.id === clauseId);
  return c ? `${c.regulation} ${c.article}` : clauseId;
};

/**
 * Run every case through retrieval and score it.
 *
 * Deterministic and free — no model call is involved, because retrieval is the
 * only thing being measured here.
 */
export function runRetrievalEval(k: number = DEFAULT_K): EvalSummary {
  let expectedFound = 0;
  let expectedTotal = 0;

  const cases: CaseResult[] = EVAL_CASES.map(evalCase => {
    const result = retrieveClauses(evalCase.input, evalCase.step, k);
    const retrievedIds = result.hits.map(h => h.clause.id);

    const found = evalCase.expected.filter(id => retrievedIds.includes(id));
    const missed = evalCase.expected
      .filter(id => !retrievedIds.includes(id))
      .map(id => {
        // Where did it actually land? A miss at rank 7 is a tuning problem;
        // a miss at rank 16 means the scoring never saw the connection at all.
        const rank = result.ranked.findIndex(h => h.clause.id === id);
        return { clauseId: id, label: labelFor(id), actualRank: rank === -1 ? null : rank + 1 };
      });

    expectedFound += found.length;
    expectedTotal += evalCase.expected.length;

    return {
      evalCase,
      found,
      missed,
      passed: missed.length === 0,
      retrievedCount: result.hits.length,
    };
  });

  return {
    k,
    cases,
    casesPassed: cases.filter(c => c.passed).length,
    casesTotal: cases.length,
    recall: expectedTotal === 0 ? 1 : expectedFound / expectedTotal,
    expectedFound,
    expectedTotal,
  };
}

/**
 * Recall at several values of K.
 *
 * This is the curve that justifies the K you picked: it shows what raising it
 * would actually buy, in recall, against the token cost of sending more
 * clauses. Picking K without this is guessing.
 */
export function recallCurve(ks: number[] = [3, 4, 5, 6, 8, 10, 17]): { k: number; recall: number; casesPassed: number }[] {
  return ks.map(k => {
    const s = runRetrievalEval(k);
    return { k, recall: s.recall, casesPassed: s.casesPassed };
  });
}
