// Retrieval stage.
//
// Before this existed, every findings request shipped the entire 17-clause
// corpus into the prompt and let the model do the selecting. That works, but it
// has two problems: it costs ~4,650 input tokens per call regardless of what
// the user actually described, and "which clauses were even considered?" was
// not a question the system could answer — the model's selection was the only
// selection.
//
// This module adds a real retrieval step in front of generation: score every
// clause against the input, send only the top matches to the model, and return
// the ranked list so the UI can show what was considered.
//
// The important design consequence: retrieval can MISS. If the right clause
// doesn't score high enough, the model never sees it and cannot cite it. That
// is a genuine new failure mode, and it is deliberate — it is what makes the
// "not clause-relevant" dismissal reason mean something, and what the review
// log's pattern insight is actually detecting. A miss you can see and measure
// is better than a silent selection you can't inspect. Recall over the
// evaluation set is the number that governs how aggressive K should be.
//
// Deliberately lexical, not embedding-based: 17 clauses do not need a vector
// store, and a scoring function you can read is worth more here than a
// similarity number you can't explain. Every score below is traceable to the
// terms that produced it.

import { CORPUS, Clause } from "./corpus";

/** How many clauses get sent to the model. See K_NOTE below. */
export const DEFAULT_K = 8;

// K_NOTE: chosen from the recall curve in lib/evalset.ts, not by intuition.
// Measured recall over the evaluation set, at the current scoring:
//
//   K=3  75.0%    K=5  79.2%    K=8  95.8%    K=17 100%
//   K=4  79.2%    K=6  87.5%    K=10 95.8%
//
// 8 is where the curve flattens: it captures nearly all the recall available,
// and going to 10 buys nothing. Sending all 17 would reach 100% but costs
// ~2.4x the input tokens and puts a dozen irrelevant clauses in front of the
// model on every call. Re-run the eval after any scoring change — this number
// is only correct for the weights it was measured against.

/** Floor: never send the model fewer than this, even on a weak-scoring input. */
const MIN_HITS = 3;

// Words carrying no retrieval signal. Short list on purpose — an aggressive
// stoplist silently drops terms that matter in this domain ("not", "third").
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "by",
  "is", "are", "we", "our", "us", "it", "this", "that", "with", "as", "be",
  "from", "their", "they", "them", "was", "were", "will", "has", "have", "had",
  "step", "none", "data", "collected", "stated", "description", "types",
]);

/**
 * Domain lexicon: plain-language words a product person actually types, mapped
 * to the LINDDUN taxonomy tags already carried on every clause in corpus.ts.
 *
 * This exists because raw term overlap fails on the shortest and most common
 * inputs. "Shared with Stripe and Google Analytics" contains not one word from
 * the text of GDPR Article 44 — but it is unmistakably a disclosure concern.
 * The lexicon bridges user vocabulary to statutory vocabulary, which is the
 * actual retrieval problem in this domain.
 */
const TAG_LEXICON: Record<string, string[]> = {
  disclosure_undisclosed_sharing: [
    "share", "shared", "sharing", "third", "party", "parties", "vendor",
    "vendors", "processor", "partner", "partners", "analytics", "advertising",
    "ad", "ads", "pixel", "crm", "sdk", "sell", "sold", "sale", "disclose",
    "disclosed", "transfer", "transferred", "recipient", "external", "stripe",
    "intercom", "meta", "google", "facebook", "salesforce", "segment",
  ],
  detectability_undisclosed_logging_retention: [
    "retain", "retained", "retention", "delete", "deleted", "deletion",
    "store", "stored", "storage", "keep", "kept", "archive", "archived",
    "log", "logs", "logging", "backup", "backups", "purge", "expire",
    "expiry", "indefinitely", "forever", "period", "duration", "years",
    "months", "days", "anonymise", "anonymize", "anonymised", "anonymized",
  ],
  non_compliance_no_legal_basis: [
    "consent", "consented", "opt", "optin", "opt-in", "permission",
    "agree", "agreed", "basis", "lawful", "legitimate", "interest",
    "contract", "necessary", "purpose", "purposes", "why", "reason",
    "withdraw", "revoke", "unsubscribe", "required", "mandatory",
  ],
  unawareness_non_transparency: [
    "notice", "notify", "notified", "inform", "informed", "disclosure",
    "policy", "privacy", "transparent", "transparency", "tell", "told",
    "aware", "unaware", "hidden", "silently", "background", "banner",
    "popup", "terms", "explain", "explained", "access", "rectify", "erase",
    "erasure", "portability", "object", "rights", "request", "requests",
  ],
  linkability_identifiability: [
    "identify", "identified", "identifier", "identifiable", "link", "linked",
    "linking", "combine", "combined", "merge", "merged", "join", "joined",
    "profile", "profiling", "cross", "device", "fingerprint", "cookie",
    "cookies", "id", "ids", "pseudonym", "pseudonymised", "de-identified",
    "aggregate", "aggregated", "unique",
  ],
};

/**
 * Which taxonomy tags each wizard step is inherently about, independent of the
 * words typed. Step 3 asks who data is shared with, so disclosure clauses are
 * relevant even if the user answers with nothing but company names.
 *
 * Step 1 carries the transparency tag because collecting data always triggers
 * a notice duty — GDPR Art. 13 and CCPA § 1798.100 apply the moment you
 * collect, whether or not the user thought to mention notice. The evaluation
 * set caught this: both were ranking 15th and 16th on a plain "email address,
 * name, browsing history" input.
 */
const STEP_TAG_PRIORS: Record<1 | 2 | 3 | 4, string[]> = {
  1: ["non_compliance_no_legal_basis", "linkability_identifiability", "unawareness_non_transparency"],
  2: ["non_compliance_no_legal_basis", "unawareness_non_transparency"],
  3: ["disclosure_undisclosed_sharing", "unawareness_non_transparency"],
  4: ["detectability_undisclosed_logging_retention", "unawareness_non_transparency"],
};

/**
 * Per-clause synonyms — the words a product person uses for the thing a clause
 * is actually about.
 *
 * The LINDDUN tags are too coarse to separate clauses that share one: Art. 16
 * (rectification) and Art. 20 (portability) are both tagged
 * non_compliance_no_legal_basis, so tag matching alone cannot tell them apart.
 * And statutory vocabulary rarely survives contact with a product description
 * — nobody writes "I exercise my right to rectification", they write "users
 * can fix a wrong address". Term overlap against the clause text finds nothing.
 *
 * This is document-side query expansion: each clause gets the vocabulary its
 * concept is described with in the wild, alongside the vocabulary the
 * legislature used. Every entry here was added in response to a specific
 * failing evaluation case, not guessed in advance.
 */
const CLAUSE_SYNONYMS: Record<string, string[]> = {
  "gdpr-art6":  ["basis", "lawful", "why", "justification", "grounds", "entitled", "allowed"],
  "gdpr-art7":  ["checkbox", "tick", "optin", "agreed", "accepted", "signup", "signed"],
  "gdpr-art12": ["plain", "readable", "understand", "understandable", "jargon", "respond", "reply"],
  "gdpr-art13": ["notice", "told", "tell", "disclosed", "upfront", "collection", "collect", "signup", "form"],
  "gdpr-art14": ["scraped", "purchased", "acquired", "enriched", "broker", "indirect", "sourced"],
  "gdpr-art15": ["access", "see", "view", "copy", "sar", "what", "hold", "holding"],
  "gdpr-art16": ["correct", "correction", "corrections", "fix", "fixed", "amend", "accurate", "accuracy", "inaccurate", "wrong", "outdated", "update"],
  "gdpr-art17": ["delete", "deleted", "deletion", "erase", "erased", "remove", "removed", "purge", "forget", "forgotten", "wipe", "close", "closure"],
  "gdpr-art18": ["freeze", "frozen", "suspend", "suspended", "pause", "paused", "restrict", "hold"],
  "gdpr-art19": ["downstream", "propagate", "inform", "notify", "recipients", "cascade"],
  "gdpr-art20": ["export", "exported", "download", "downloaded", "csv", "json", "copy", "portable", "portability", "takeout", "machine-readable", "migrate"],
  "gdpr-art21": ["object", "opt-out", "optout", "unsubscribe", "stop", "marketing", "promotional", "newsletter"],
  "gdpr-art22": ["automated", "automatic", "automatically", "algorithm", "algorithmic", "model", "score", "scoring", "decision", "decline", "reject", "approve", "profiling", "human"],
  "ccpa-1798.100": ["notice", "collection", "collect", "categories", "policy", "disclose", "upfront", "signup"],
  "ccpa-1798.120": ["sell", "sold", "sale", "share", "shared", "sharing", "broker", "brokers", "advertising", "attribution", "optout", "opt-out"],
  "hipaa-164.502a": ["patient", "patients", "phi", "health", "medical", "clinical", "treatment", "diagnosis", "insurance", "provider"],
  "hipaa-164.502b": ["minimum", "necessary", "full", "entire", "complete", "whole", "everything", "all", "excessive"],
};

/**
 * Clauses pinned into the candidate set for a step regardless of score.
 *
 * Some obligations attach to the activity, not to the wording. If you collect
 * personal data at all, GDPR Art. 13 and CCPA § 1798.100 impose notice duties —
 * whether or not the description happens to contain the word "notice". If you
 * have a processing purpose, Art. 6 requires a lawful basis for it. No amount
 * of lexical scoring should be able to drop those, because their relevance
 * never depended on vocabulary in the first place.
 *
 * The evaluation set is what made this visible: every remaining failure at
 * K=6 was one of these unconditional duties ranking 8th to 14th behind clauses
 * that merely shared words with the input. Pinning is the correct fix rather
 * than more synonym-tuning, because the problem was never that the words were
 * missing — it was that the obligation does not depend on them.
 *
 * Kept deliberately short. Every pinned clause costs a slot that lexical
 * retrieval could have used, so this holds only obligations that genuinely
 * apply unconditionally at that step.
 */
const STEP_PINNED_CLAUSES: Record<1 | 2 | 3 | 4, string[]> = {
  // Collecting personal data at all triggers both notice duties and the
  // requirement to have a lawful basis for the collection.
  1: ["gdpr-art13", "ccpa-1798.100", "gdpr-art6"],
  2: ["gdpr-art6"],    // a purpose always needs a lawful basis
  3: ["gdpr-art13"],   // recipients must be disclosed at collection
  4: ["gdpr-art13"],   // retention period must be disclosed
};

/** Field weights. A term in a clause title is a stronger signal than the same
 *  term buried in a long statutory paragraph. */
const W_TITLE = 3.0;
const W_TEXT = 1.0;
const W_LEXICON = 2.5;
const W_STEP_PRIOR = 1.2;
/** Highest weight of the four: synonyms are hand-curated per clause, so a hit
 *  is a much more precise signal than a shared tag or a common term. */
const W_SYNONYM = 4.0;

export interface RetrievalHit {
  clause: Clause;
  score: number;
  /** Why this clause scored — shown in the UI and used by the eval runner. */
  reasons: string[];
}

export interface RetrievalResult {
  /** Clauses actually sent to the model, best first. */
  hits: RetrievalHit[];
  /** Everything scored, best first — for inspecting near-misses. */
  ranked: RetrievalHit[];
  /** Corpus size this ran against. */
  considered: number;
}

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));

/**
 * Inverse document frequency across the corpus. A term appearing in every
 * clause ("processing", "controller", "personal") carries almost no
 * discriminating signal; a term in one clause carries a lot.
 */
function buildIdf(): Map<string, number> {
  const df = new Map<string, number>();
  for (const clause of CORPUS) {
    const seen = new Set(tokenize(`${clause.title} ${clause.text}`));
    for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + CORPUS.length / count));
  }
  return idf;
}

// Computed once — the corpus is a static import and never changes at runtime.
const IDF = buildIdf();

/** Reverse index: term -> tags it signals. Built once from TAG_LEXICON. */
const LEXICON_INDEX: Map<string, string[]> = (() => {
  const index = new Map<string, string[]>();
  for (const [tag, words] of Object.entries(TAG_LEXICON)) {
    for (const word of words) {
      index.set(word, [...(index.get(word) ?? []), tag]);
    }
  }
  return index;
})();

/**
 * Score the corpus against one slice of flow input and return the top K.
 *
 * @param input  The user's text for this step.
 * @param step   Which wizard step, used for tag priors.
 * @param k      How many clauses to send onward.
 */
export function retrieveClauses(
  input: string,
  step: 1 | 2 | 3 | 4,
  k: number = DEFAULT_K
): RetrievalResult {
  const terms = tokenize(input);

  // Which taxonomy tags does this input point at? Two sources: words the user
  // typed that appear in the lexicon, and the step's inherent subject matter.
  const signalledTags = new Map<string, string[]>();
  for (const term of terms) {
    for (const tag of LEXICON_INDEX.get(term) ?? []) {
      signalledTags.set(tag, [...(signalledTags.get(tag) ?? []), term]);
    }
  }

  const ranked: RetrievalHit[] = CORPUS.map(clause => {
    let score = 0;
    const reasons: string[] = [];

    const titleTerms = new Set(tokenize(clause.title));
    const textTerms = new Set(tokenize(clause.text));

    // 1. Direct term overlap, weighted by how rare the term is corpus-wide.
    const matched: string[] = [];
    for (const term of new Set(terms)) {
      const idf = IDF.get(term) ?? 0;
      if (idf === 0) continue;
      if (titleTerms.has(term)) {
        score += idf * W_TITLE;
        matched.push(term);
      } else if (textTerms.has(term)) {
        score += idf * W_TEXT;
        matched.push(term);
      }
    }
    if (matched.length) {
      reasons.push(`matched: ${matched.slice(0, 5).join(", ")}`);
    }

    // 2. Lexicon bridge — user vocabulary mapped onto this clause's tags.
    for (const tag of clause.taxonomy_tags) {
      const trigger = signalledTags.get(tag);
      if (trigger) {
        score += W_LEXICON * Math.min(trigger.length, 3);
        reasons.push(`"${trigger[0]}" → ${tag.replace(/_/g, " ")}`);
      }
    }

    // 3. Per-clause synonyms — product vocabulary for this specific clause's
    // concept. Highest weight, because these are curated per clause rather
    // than shared across a whole tag.
    const synonyms = CLAUSE_SYNONYMS[clause.id] ?? [];
    const synHits = [...new Set(terms)].filter(t => synonyms.includes(t));
    if (synHits.length) {
      score += W_SYNONYM * Math.min(synHits.length, 3);
      reasons.push(`concept match: ${synHits.slice(0, 3).join(", ")}`);
    }

    // 4. Step prior — what this step is about regardless of wording.
    for (const tag of clause.taxonomy_tags) {
      if (STEP_TAG_PRIORS[step].includes(tag)) {
        score += W_STEP_PRIOR;
      }
    }

    return { clause, score, reasons };
  }).sort((a, b) => b.score - a.score);

  // Take the top K that actually scored, but never starve the model: if fewer
  // than MIN_HITS cleared zero, pad from the ranked list so a thin input still
  // gets a fair check rather than an automatic "not covered".
  const scoring = ranked.filter(h => h.score > 0);
  const scored = (scoring.length >= MIN_HITS ? scoring : ranked).slice(0, k);

  // Pinned clauses go in whether or not they scored. They are placed first and
  // count against K, so the candidate set stays the size the caller asked for.
  const pinnedIds = STEP_PINNED_CLAUSES[step];
  const pinned: RetrievalHit[] = pinnedIds
    .map(id => {
      const existing = ranked.find(h => h.clause.id === id);
      if (!existing) return null;
      return {
        ...existing,
        reasons: ["always applies at this step", ...existing.reasons],
      };
    })
    .filter((h): h is RetrievalHit => h !== null);

  const pinnedSet = new Set(pinnedIds);
  const hits = [...pinned, ...scored.filter(h => !pinnedSet.has(h.clause.id))].slice(0, k);

  return { hits, ranked, considered: CORPUS.length };
}
