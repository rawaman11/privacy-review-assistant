// Confidence thresholds.
//
// The model used to pick the finding variant itself — it returned the literal
// string "grounded" or "low-confidence" and the UI rendered whatever it said.
// That put a product decision inside the prompt: the boundary between "this
// clause applies" and "this might apply" was whatever the model felt that run,
// unversioned and untunable.
//
// Now the model reports a confidence number and this module owns the cutoffs.
// Two things follow from that:
//
//  1. The boundary is a value you can tune against the evaluation set, not a
//     sentence you have to re-argue in the prompt.
//  2. It is a product decision made in product code. Where "probably applies"
//     stops and "clearly applies" begins is a judgment about how much caution
//     this tool owes a non-lawyer — the model has no view on that.
//
// Thresholds are deliberately asymmetric. Overstating certainty is the more
// expensive error here: a "grounded" badge tells a generalist to act, while a
// "low-confidence" one tells them to look closer. So GROUNDED sits high.

import { Clause } from "./corpus";

export type ConfidenceVariant = "grounded" | "low-confidence" | "not-covered";

/** At or above this, a clause is presented as clearly applying. Set high —
 *  a false "grounded" is worse than a cautious "low-confidence". */
export const GROUNDED_THRESHOLD = 0.75;

/** At or above this (but below GROUNDED), the clause plausibly applies and is
 *  shown with an amber badge. Below it, we do not make a claim at all. */
export const LOW_CONFIDENCE_THRESHOLD = 0.40;

export interface ClassificationInput {
  /** Model's self-reported confidence, 0-1. */
  confidence: number | null | undefined;
  /** Clause the model cited, already resolved against the corpus. Undefined
   *  means the id did not resolve — see the demotion rule below. */
  clause: Clause | undefined;
}

export interface Classification {
  variant: ConfidenceVariant;
  /** Confidence clamped to 0-1, or null if the model omitted it. */
  confidence: number | null;
  /** Set when the outcome differs from what confidence alone would give —
   *  surfaced in the UI so a demotion is never silent. */
  demotedReason?: string;
}

/**
 * Map a model response onto a finding variant.
 *
 * The demotion rule is the important part. A finding can only be shown as
 * "grounded" if its clause actually resolved, because the whole promise of that
 * badge is a citation displayed inline. A confident finding whose clause_id
 * doesn't exist in the corpus is not a grounded finding — it is a hallucinated
 * one, and the old code would have rendered it with a red badge and no
 * citation. It is now demoted to "not-covered" instead: no claim, no
 * accept/dismiss, escalation only.
 */
export function classify({ confidence, clause }: ClassificationInput): Classification {
  const score =
    typeof confidence === "number" && Number.isFinite(confidence)
      ? Math.min(1, Math.max(0, confidence))
      : null;

  // No resolvable clause means there is nothing to cite, so there is nothing to
  // assert — regardless of how certain the model claimed to be.
  if (!clause) {
    return {
      variant: "not-covered",
      confidence: score,
      demotedReason:
        score !== null && score >= LOW_CONFIDENCE_THRESHOLD
          ? "The model reported confidence but cited a clause that is not in the corpus."
          : undefined,
    };
  }

  // A resolved clause with no usable confidence is treated as ambiguous rather
  // than trusted — absence of a signal is not evidence of certainty.
  if (score === null) {
    return {
      variant: "low-confidence",
      confidence: null,
      demotedReason: "No confidence score was returned, so this is shown as unconfirmed.",
    };
  }

  if (score >= GROUNDED_THRESHOLD) return { variant: "grounded", confidence: score };
  if (score >= LOW_CONFIDENCE_THRESHOLD) return { variant: "low-confidence", confidence: score };

  return { variant: "not-covered", confidence: score };
}
