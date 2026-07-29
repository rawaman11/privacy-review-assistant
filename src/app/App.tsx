import React, { useState, useRef, useEffect, KeyboardEvent, useMemo } from "react";
import {
  Plus, X, ChevronRight, ChevronLeft,
  FileText, ClipboardList, BookOpen,
  AlertTriangle, Send, Filter, Layers, AlignLeft,
  Check, ArrowRight, Loader2, Search, Target
} from "lucide-react";
import { CORPUS } from "../lib/corpus";
import { retrieveClauses, RetrievalResult, DEFAULT_K } from "../lib/retrieval";
import { classify, GROUNDED_THRESHOLD, LOW_CONFIDENCE_THRESHOLD } from "../lib/confidence";
import { runRetrievalEval, recallCurve } from "../lib/evalset";
import { callClaudeJSON } from "../lib/anthropicClient";

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen = "review" | "log" | "corpus" | "eval";
type InputMode = "structured" | "freetext";
type FindingVariant = "grounded" | "low-confidence" | "not-covered" | "error";
type FindingStatus = "pending" | "accepted" | "dismissed";
type DismissReason = "not-clause-relevant" | "false-positive" | "already-handled";
type FieldKey = "dataCollected" | "purpose" | "thirdParties" | "retention";

interface DataTag { id: string; label: string; }

interface Finding {
  id: string;
  variant: FindingVariant;
  /** Model's self-reported certainty, 0-1. Null when it returned none, or on
   *  an error finding. The variant above is derived from this by the
   *  thresholds in lib/confidence.ts — this field is kept so the UI can show
   *  the raw number the decision was made from. */
  confidence?: number | null;
  /** Set when the variant is lower than confidence alone would give — e.g. a
   *  cited clause that isn't in the corpus. Shown to the user; never silent. */
  demotedReason?: string;
  category: string;
  explanation: string;
  citation?: string;
  regulation: string;
  status: FindingStatus;
  dismissReason?: DismissReason;
  step: 1 | 2 | 3 | 4;
  reviewId: string;
}

interface TextSpan { start: number; end: number; field: FieldKey; }

interface ExtractionResult {
  spans: TextSpan[];
  dataCollected: string | null;
  purpose: string | null;
  thirdParties: string | null;
  retention: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SENSITIVE_KEYWORDS = [
  "health", "medical", "biometric", "genetic", "financial",
  "bank", "credit", "racial", "ethnic", "religious", "political",
  "sexual", "criminal", "ssn", "passport", "diagnosis",
];

const FIELD_COLORS: Record<FieldKey, { bg: string; border: string; label: string }> = {
  dataCollected: { bg: "#EFF6FF", border: "#93C5FD", label: "Data collected" },
  purpose:       { bg: "#F0FDF4", border: "#86EFAC", label: "Purpose" },
  thirdParties:  { bg: "#FAF5FF", border: "#D8B4FE", label: "Third parties" },
  retention:     { bg: "#FFF7ED", border: "#FDBA74", label: "Retention" },
};

const DISMISS_REASONS: { value: DismissReason; label: string }[] = [
  { value: "not-clause-relevant", label: "Not clause-relevant" },
  { value: "false-positive",      label: "False positive" },
  { value: "already-handled",     label: "Already handled elsewhere" },
];

const isSensitive = (label: string) =>
  SENSITIVE_KEYWORDS.some(k => label.toLowerCase().includes(k));

let _uid = 0;
const uid = () => `id-${++_uid}`;

// ─── Finding generation (real LLM call, grounded in CORPUS) ────────────────────

/** What the model returns. Note it reports a confidence NUMBER, not a variant —
 *  the variant is decided by our thresholds in lib/confidence.ts, so where
 *  "might apply" becomes "clearly applies" is a product decision in product
 *  code rather than a judgement made inside the prompt. */
interface RawFinding {
  confidence: number;
  category: string;
  explanation: string;
  clause_id: string | null;
}

const FINDINGS_SYSTEM_PROMPT = `You are a privacy-compliance reviewer assistant. You are given a slice of a
product flow description and a set of candidate regulation clauses that were retrieved as most
relevant to that input. The candidate set is a subset of a larger corpus — judge only what you
are given, and do not reason about clauses that are not present.

Rules you must follow exactly:
- Only cite a clause_id that appears in the candidate clauses provided to you. Never invent a clause id or citation.
- Report your certainty as "confidence", a number between 0 and 1. Calibrate it honestly:
    0.9-1.0  the clause plainly governs this input; you would defend the citation
    0.6-0.9  the clause applies on a reasonable reading, but the input leaves room for doubt
    0.3-0.6  the clause is topically related but the input is too vague to say it applies
    0.0-0.3  no real connection
  Do not inflate confidence to seem useful. An honest 0.5 is more valuable than a confident wrong answer.
- If nothing in the candidate clauses applies, return a single finding with confidence 0, clause_id null,
  category "Not clearly covered", and an explanation of what would need legal review.
- Do not guess facts not present in the input. Do not pad with filler findings.
- Return 0-3 findings maximum for this input.
- Respond with ONLY a JSON array, no prose, no markdown fences. Each item:
  { "confidence": number, "category": string, "explanation": string, "clause_id": string | null }`;

/** What one step produced: the findings, plus the retrieval that fed them. The
 *  retrieval travels with the result so the UI can show which clauses were
 *  actually considered — a finding you can't trace back to a candidate set is
 *  not auditable. */
interface StepResult {
  findings: Finding[];
  retrieval: RetrievalResult | null;
}

async function generateFindingsLLM(
  step: 1 | 2 | 3 | 4,
  data: { tags?: DataTag[]; purpose?: string; thirdParties?: string; retention?: string },
  reviewId: string
): Promise<StepResult> {
  const stepInput =
    step === 1 ? `Data types collected: ${(data.tags ?? []).map(t => t.label).join(", ") || "(none)"}` :
    step === 2 ? `Stated purpose: ${data.purpose || "(none)"}` :
    step === 3 ? `Third parties data is shared with: ${data.thirdParties || "(none)"}` :
    `Retention description: ${data.retention || "(none)"}`;

  if (
    (step === 1 && !(data.tags ?? []).length) ||
    (step === 2 && !data.purpose?.trim()) ||
    (step === 3 && !data.thirdParties?.trim()) ||
    (step === 4 && !data.retention?.trim())
  ) {
    return { findings: [], retrieval: null };
  }

  // Retrieval stage. Only the top-scoring clauses go to the model, not the
  // whole corpus — see src/lib/retrieval.ts for the scoring and the tradeoff
  // this introduces (a clause that doesn't rank can't be cited).
  const retrieval = retrieveClauses(stepInput, step, DEFAULT_K);

  const corpusBlock = retrieval.hits.map(
    h => `clause_id: ${h.clause.id}\nregulation: ${h.clause.regulation}\narticle: ${h.clause.article} — ${h.clause.title}\ntext: ${h.clause.text}`
  ).join("\n\n---\n\n");

  const userMessage =
    `CANDIDATE CLAUSES (${retrieval.hits.length} of ${retrieval.considered} retrieved for this input):\n${corpusBlock}` +
    `\n\nFLOW INPUT (step ${step}):\n${stepInput}`;

  let raw: RawFinding[];
  try {
    raw = await callClaudeJSON<RawFinding[]>(FINDINGS_SYSTEM_PROMPT, userMessage);
  } catch (e) {
    return {
      findings: [{
        id: uid(), variant: "error", category: "Analysis unavailable",
        explanation: e instanceof Error ? e.message : "Could not reach the model.",
        regulation: "—", status: "pending", step, reviewId,
      }],
      retrieval,
    };
  }

  const findings = raw.map(r => {
    // Citation text is resolved from our own corpus, never taken from the
    // model — an invented clause_id resolves to nothing and renders no
    // citation, rather than a convincing fake one.
    const clause = r.clause_id ? CORPUS.find(c => c.id === r.clause_id) : undefined;

    // Variant comes from our thresholds, not the model's self-assessment.
    // classify() also demotes a confident finding whose clause didn't resolve,
    // so a "grounded" badge can never appear without a citation behind it.
    const { variant, confidence, demotedReason } = classify({ confidence: r.confidence, clause });

    return {
      id: uid(),
      variant,
      confidence,
      demotedReason,
      category: r.category,
      explanation: r.explanation,
      citation: clause ? `${clause.regulation} ${clause.article} — ${clause.title}` : undefined,
      regulation: clause?.regulation ?? "—",
      status: "pending" as FindingStatus,
      step,
      reviewId,
    };
  });

  return { findings, retrieval };
}


// ─── Free-text extraction (real LLM call) ──────────────────────────────────────

interface RawExtraction {
  data_collected: string | null;
  data_collected_quote: string | null;
  purpose: string | null;
  purpose_quote: string | null;
  third_parties: string | null;
  third_parties_quote: string | null;
  retention: string | null;
  retention_quote: string | null;
}

const EXTRACTION_SYSTEM_PROMPT = `You extract structured fields from a plain-language description of a product's
data flow. Extract exactly these fields: data_collected, purpose, third_parties, retention.

Rules:
- If a field is not mentioned or not clearly stated, return null for it. Never guess or infer a value that
  isn't actually in the text.
- For every non-null field, also return an exact verbatim substring copied from the input text that the
  field value was derived from (the _quote fields). This must be an exact substring match, not a paraphrase.
- Respond with ONLY a JSON object, no prose, no markdown fences, matching this shape:
  { "data_collected": string | null, "data_collected_quote": string | null,
    "purpose": string | null, "purpose_quote": string | null,
    "third_parties": string | null, "third_parties_quote": string | null,
    "retention": string | null, "retention_quote": string | null }`;

async function extractFieldsLLM(text: string): Promise<ExtractionResult> {
  const raw = await callClaudeJSON<RawExtraction>(EXTRACTION_SYSTEM_PROMPT, text);

  const spans: TextSpan[] = [];
  const addSpan = (quote: string | null, field: FieldKey) => {
    if (!quote) return;
    const idx = text.indexOf(quote);
    if (idx !== -1) spans.push({ start: idx, end: idx + quote.length, field });
  };
  addSpan(raw.data_collected_quote, "dataCollected");
  addSpan(raw.purpose_quote, "purpose");
  addSpan(raw.third_parties_quote, "thirdParties");
  addSpan(raw.retention_quote, "retention");

  return {
    spans,
    dataCollected: raw.data_collected,
    purpose: raw.purpose,
    thirdParties: raw.third_parties,
    retention: raw.retention,
  };
}

function renderHighlighted(text: string, spans: TextSpan[]) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const segs: { text: string; field: FieldKey | null }[] = [];
  let pos = 0;
  for (const sp of sorted) {
    if (sp.start > pos) segs.push({ text: text.slice(pos, sp.start), field: null });
    segs.push({ text: text.slice(sp.start, sp.end), field: sp.field });
    pos = sp.end;
  }
  if (pos < text.length) segs.push({ text: text.slice(pos), field: null });
  return segs;
}

// ─── Review log insight ───────────────────────────────────────────────────────

function computeInsight(dismissed: Finding[]): string | null {
  if (dismissed.length < 3) return null;
  const byCitation: Record<string, { total: number; notRelevant: number }> = {};
  for (const f of dismissed) {
    if (!f.citation) continue;
    if (!byCitation[f.citation]) byCitation[f.citation] = { total: 0, notRelevant: 0 };
    byCitation[f.citation].total++;
    if (f.dismissReason === "not-clause-relevant") byCitation[f.citation].notRelevant++;
  }
  let best: { clause: string; count: number; total: number } | null = null;
  for (const [clause, val] of Object.entries(byCitation)) {
    if (val.notRelevant >= 2 && (!best || val.notRelevant > best.count)) {
      best = { clause, count: val.notRelevant, total: val.total };
    }
  }
  if (!best) return null;
  // Now literally true: there is a retrieval stage, and this is the signal that
  // it is ranking this clause too highly for inputs it doesn't actually govern.
  // The fix lives in the scoring weights or the tag lexicon in retrieval.ts,
  // not in the prompt.
  return `${best.count} of ${best.total} dismissals on "${best.clause}" were marked "not clause-relevant" — retrieval is ranking this clause too highly for inputs it doesn't apply to.`;
}

// ─── UI primitives ────────────────────────────────────────────────────────────

/** Spoken description of each variant. WCAG 1.4.1 (Use of Colour): the tint is
 *  the only visual signal separating a grounded finding from an unconfirmed
 *  one, so the distinction has to exist in the accessibility tree too. This is
 *  rendered visually-hidden inside the badge rather than as a title attribute,
 *  because title text is unreliable for screen readers and invisible to
 *  keyboard users. */
const VARIANT_LABEL: Record<FindingVariant, string> = {
  "grounded": "Clause clearly applies",
  "low-confidence": "Clause may apply, unconfirmed",
  "not-covered": "Not clearly covered by the corpus",
  "error": "Could not be checked",
};

function VariantBadge({ variant, category }: { variant: FindingVariant; category: string }) {
  // Contrast measured against the surface each badge actually sits on.
  // gray-400 (2.54:1) and gray-500 on gray-100 (4.39:1) both failed AA and
  // were raised to gray-600 (7.56:1 and 6.87:1).
  const cls =
    variant === "grounded"
      ? "bg-red-50 text-red-700 border border-red-200"
      : variant === "low-confidence"
      ? "bg-amber-50 text-amber-800 border border-amber-200"
      : variant === "error"
      ? "bg-transparent text-gray-600 border border-dashed border-gray-400"
      : "bg-gray-100 text-gray-600 border border-gray-300";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      <span className="sr-only">{VARIANT_LABEL[variant]}: </span>
      {category}
    </span>
  );
}

function RegBadge({ reg }: { reg: string }) {
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[11px] font-medium bg-gray-100 text-gray-500 border border-gray-200">
      {reg}
    </span>
  );
}

/**
 * Shows what the retrieval stage considered for a step.
 *
 * This is here because retrieval introduced a failure mode that generation
 * alone did not have: a clause that doesn't rank never reaches the model and
 * therefore cannot be cited, no matter how relevant it was. That failure is
 * invisible unless the candidate set is inspectable — so it is. The near-miss
 * list matters as much as the sent list: it is where a retrieval miss is
 * actually visible, and it tells a reviewer whether "not clearly covered"
 * means "nothing applies" or "the right clause ranked seventh".
 */
function RetrievalDisclosure({ retrieval }: { retrieval: RetrievalResult }) {
  const [open, setOpen] = useState(false);
  const nearMisses = retrieval.ranked
    .slice(retrieval.hits.length)
    .filter(h => h.score > 0)
    .slice(0, 3);

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <Search size={10} />
        {retrieval.hits.length} of {retrieval.considered} clauses retrieved
        <ChevronRight size={10} className={`transition-transform ${open ? "rotate-90" : ""}`} />
      </button>

      {open && (
        <div className="mt-2 p-3 rounded-lg border border-border bg-muted/30 flex flex-col gap-2.5">
          <div>
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Sent to the model
            </p>
            <div className="flex flex-col gap-1">
              {retrieval.hits.map(h => (
                <div key={h.clause.id} className="flex items-baseline gap-2">
                  <span className="text-[10px] font-mono text-muted-foreground w-8 shrink-0 text-right">
                    {h.score.toFixed(1)}
                  </span>
                  <div className="min-w-0">
                    <span className="text-[11px] text-foreground">
                      {h.clause.regulation} {h.clause.article}
                    </span>
                    {h.reasons.length > 0 && (
                      <span className="text-[10px] text-muted-foreground"> — {h.reasons[0]}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {nearMisses.length > 0 && (
            <div className="pt-2 border-t border-border">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                Ranked but not sent
              </p>
              <div className="flex flex-col gap-1">
                {nearMisses.map(h => (
                  <div key={h.clause.id} className="flex items-baseline gap-2 opacity-60">
                    <span className="text-[10px] font-mono text-muted-foreground w-8 shrink-0 text-right">
                      {h.score.toFixed(1)}
                    </span>
                    <span className="text-[11px] text-foreground">
                      {h.clause.regulation} {h.clause.article}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground italic mt-1.5 leading-snug">
                These scored but fell below the cutoff. If a finding you expected is missing,
                this is where it went — that is a retrieval miss, not a model error.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FindingCard({
  finding, onAccept, onDismiss, onSendToLegal
}: {
  finding: Finding;
  onAccept: () => void;
  onDismiss: () => void;
  onSendToLegal: () => void;
}) {
  const borderColor =
    finding.variant === "grounded"
      ? "border-l-red-400"
      : finding.variant === "low-confidence"
      ? "border-l-amber-400"
      : "border-l-gray-300";

  const opacity = finding.status !== "pending" ? "opacity-50" : "";

  return (
    <div className={`bg-card border border-border rounded-lg border-l-[3px] ${borderColor} p-4 ${opacity} transition-opacity`}>
      <div className="flex items-start gap-2 mb-2">
        <VariantBadge variant={finding.variant} category={finding.category} />
        <RegBadge reg={finding.regulation} />
        {/* green-600 measured 3.30:1 on white and green-700 measures 5.02:1 */}
        {finding.status === "accepted" && (
          <span className="ml-auto text-[11px] text-green-700 font-medium flex items-center gap-0.5">
            <Check size={11} aria-hidden="true" /> Accepted
          </span>
        )}
        {finding.status === "dismissed" && (
          <span className="ml-auto text-[11px] text-gray-600 font-medium">Dismissed</span>
        )}
      </div>
      <p className="text-sm text-foreground leading-relaxed mb-2">{finding.explanation}</p>
      {finding.citation && (
        <p className="text-xs text-muted-foreground font-medium mb-1.5">{finding.citation}</p>
      )}

      {/* The number the badge was derived from, and the cutoff it cleared.
          Showing the threshold alongside the score is the point: it tells the
          reader this is a tunable product decision, not the model's opinion. */}
      {typeof finding.confidence === "number" && finding.variant !== "error" && (
        <p className="text-[11px] text-muted-foreground mb-2 font-mono">
          confidence {finding.confidence.toFixed(2)}
          <span className="text-muted-foreground/60">
            {" · "}
            {finding.confidence >= GROUNDED_THRESHOLD
              ? `≥ ${GROUNDED_THRESHOLD} grounded`
              : finding.confidence >= LOW_CONFIDENCE_THRESHOLD
              ? `≥ ${LOW_CONFIDENCE_THRESHOLD} unconfirmed`
              : `< ${LOW_CONFIDENCE_THRESHOLD} no claim made`}
          </span>
        </p>
      )}

      {finding.demotedReason && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-2 leading-snug">
          Downgraded — {finding.demotedReason}
        </p>
      )}
      {finding.variant !== "not-covered" && finding.variant !== "error" && finding.status === "pending" && (
        <div className="flex gap-2">
          <button
            onClick={onAccept}
            className="px-3 py-1.5 text-xs font-medium rounded border border-border text-foreground hover:bg-muted transition-colors"
          >
            Accept
          </button>
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 text-xs font-medium rounded border border-border text-muted-foreground hover:bg-muted transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}
      {finding.variant === "not-covered" && finding.status === "pending" && (
        <button
          onClick={onSendToLegal}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-border text-foreground hover:bg-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        >
          <Send size={11} aria-hidden="true" /> Send to legal
        </button>
      )}
      {/* gray-400 measured 2.54:1 — well under AA. Raised to gray-600 (7.56:1). */}
      {finding.variant === "error" && (
        <p className="text-xs text-gray-600 italic">
          Not a finding — the model couldn't be reached. Nothing to accept or dismiss here.
        </p>
      )}
    </div>
  );
}

/**
 * Dismiss dialog.
 *
 * Accessibility work here covers the things a hand-rolled modal usually gets
 * wrong, all of which are AA failures rather than polish:
 *   - role="dialog" + aria-modal + aria-labelledby, so it is announced as a
 *     dialog with a name instead of an anonymous group of buttons (4.1.2)
 *   - focus moves in on open and returns to the trigger on close (2.4.3)
 *   - Tab cycles inside the dialog rather than escaping to the page behind it
 *   - Escape closes it (2.1.2 — a keyboard user must be able to get out)
 *   - the reason list is a radiogroup, because that is what it is: one choice
 *     from a fixed set, and arrow-key semantics follow from saying so
 */
function DismissModal({
  onConfirm, onCancel
}: { onConfirm: (reason: DismissReason) => void; onCancel: () => void }) {
  const [selected, setSelected] = useState<DismissReason | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Remember what had focus so it can be restored when the dialog closes —
    // otherwise focus falls back to <body> and a keyboard user loses their place.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    firstOptionRef.current?.focus();

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;

      // Keep Tab inside the dialog.
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dismiss-title"
        aria-describedby="dismiss-desc"
        onClick={e => e.stopPropagation()}
        className="bg-card border border-border rounded-xl p-6 w-full max-w-sm max-h-[90vh] overflow-y-auto"
      >
        <h3 id="dismiss-title" className="text-sm font-medium text-foreground mb-1">
          Dismiss finding
        </h3>
        <p id="dismiss-desc" className="text-xs text-muted-foreground mb-4">
          Select a reason before dismissing.
        </p>

        <div role="radiogroup" aria-labelledby="dismiss-title" className="flex flex-col gap-2 mb-5">
          {DISMISS_REASONS.map((r, i) => (
            <button
              key={r.value}
              ref={i === 0 ? firstOptionRef : undefined}
              role="radio"
              aria-checked={selected === r.value}
              onClick={() => setSelected(r.value)}
              className={`text-left px-3 py-2.5 rounded-lg border text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${
                selected === r.value
                  ? "border-foreground bg-foreground/5 text-foreground font-medium"
                  : "border-border text-foreground hover:bg-muted"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-foreground hover:bg-muted rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          >
            Cancel
          </button>
          <button
            onClick={() => selected && onConfirm(selected)}
            disabled={!selected}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-foreground text-primary-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-foreground/90 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tag input ────────────────────────────────────────────────────────────────

function TagInput({
  tags, onChange
}: { tags: DataTag[]; onChange: (tags: DataTag[]) => void }) {
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = () => {
    const label = val.trim();
    if (!label) return;
    onChange([...tags, { id: uid(), label }]);
    setVal("");
  };

  const removeTag = (id: string) => onChange(tags.filter(t => t.id !== id));

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); addTag(); }
    if (e.key === "Backspace" && !val && tags.length) removeTag(tags[tags.length - 1].id);
  };

  const sensitiveTags = tags.filter(t => isSensitive(t.label));
  const typingSensitive = val.trim().length > 2 && isSensitive(val);

  return (
    <div>
      <div
        className="min-h-[80px] flex flex-wrap gap-1.5 p-2.5 border border-border rounded-lg bg-background cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map(tag => (
          <span
            key={tag.id}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border ${
              isSensitive(tag.label)
                ? "bg-amber-50 text-amber-800 border-amber-200"
                : "bg-secondary text-secondary-foreground border-border"
            }`}
          >
            {tag.label}
            {/* Icon-only control: without a label this is announced as just
                "button" (WCAG 4.1.2). */}
            <button
              onClick={(e) => { e.stopPropagation(); removeTag(tag.id); }}
              aria-label={`Remove ${tag.label}`}
              className="hover:text-destructive transition-colors rounded focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground"
            >
              <X size={10} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={onKey}
          aria-label="Add a data type"
          aria-describedby="tag-input-help"
          placeholder={tags.length === 0 ? "Type a data type and press Enter…" : "Add another…"}
          className="flex-1 min-w-[140px] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
        />
      </div>
      {/* Announced when it appears — a sighted user sees the amber panel, a
          screen-reader user would otherwise get nothing. */}
      {(typingSensitive || sensitiveTags.length > 0) && (
        <div
          role="status"
          className="mt-2 flex items-start gap-1.5 p-2.5 rounded-lg border border-amber-200 bg-amber-50"
        >
          <AlertTriangle size={13} className="text-amber-700 mt-0.5 shrink-0" aria-hidden="true" />
          <p className="text-xs text-amber-800">
            {typingSensitive
              ? `"${val}" looks like a sensitive category.`
              : `${sensitiveTags.map(t => t.label).join(", ")} ${sensitiveTags.length === 1 ? "is" : "are"} a sensitive category.`}
            {" "}This may require a higher legal basis (explicit consent or Art. 9 exception) under GDPR, and HIPAA may apply.
          </p>
        </div>
      )}
      <p id="tag-input-help" className="mt-1.5 text-xs text-muted-foreground">Press Enter to add each type. Sensitive types are highlighted.</p>
    </div>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ step, total }: { step: number; total: number }) {
  // The segments carry no information a screen reader can use, and the
  // "Step N of 4" text above already says it — so they are hidden rather than
  // given redundant ARIA. Marking them up as a progressbar would announce the
  // same fact twice.
  return (
    <div className="flex gap-1" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
            i < step ? "bg-foreground" : "bg-border"
          }`}
        />
      ))}
    </div>
  );
}

// ─── Free text panel ──────────────────────────────────────────────────────────

function FreeTextPanel({
  onConfirm
}: { onConfirm: (data: { tags: DataTag[]; purpose: string; thirdParties: string; retention: string }) => void }) {
  const [text, setText] = useState("");
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  // Debounce: wait 800ms after typing stops before calling the model.
  useEffect(() => {
    if (text.trim().length <= 20) {
      setExtraction(null);
      setExtractError(null);
      return;
    }
    setIsExtracting(true);
    setExtractError(null);
    const handle = setTimeout(async () => {
      try {
        const result = await extractFieldsLLM(text);
        setExtraction(result);
      } catch (e) {
        setExtractError(e instanceof Error ? e.message : "Extraction failed.");
        setExtraction(null);
      } finally {
        setIsExtracting(false);
      }
    }, 800);
    return () => clearTimeout(handle);
  }, [text]);

  const segments = useMemo(() => extraction ? renderHighlighted(text, extraction.spans) : null, [text, extraction]);

  const handleConfirm = () => {
    if (!extraction) return;
    const parseTags = (val: string | null): DataTag[] =>
      val ? val.split(/[,;]/).map(s => s.trim()).filter(Boolean).map(label => ({ id: uid(), label })) : [];
    onConfirm({
      tags: parseTags(extraction.dataCollected),
      purpose: extraction.purpose ?? "",
      thirdParties: extraction.thirdParties ?? "",
      retention: extraction.retention ?? "",
    });
  };

  const fieldOrder: FieldKey[] = ["dataCollected", "purpose", "thirdParties", "retention"];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          Describe your flow
        </label>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Describe your product flow in plain language. For example: 'When users sign up, we collect their name, email address, and browsing history to personalise recommendations. We share this data with our analytics vendor and a third-party ad network. Data is retained for 12 months after the last login, then deleted.'"
          className="w-full h-40 p-3 text-sm bg-background border border-border rounded-lg resize-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground focus:border-foreground/30 placeholder:text-muted-foreground transition-colors leading-relaxed"
        />
      </div>

      {extraction && segments && (
        <>
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Annotated text
            </p>
            <div className="p-3 rounded-lg border border-border bg-background text-sm leading-relaxed">
              {segments.map((seg, i) =>
                seg.field ? (
                  <span
                    key={i}
                    style={{
                      backgroundColor: FIELD_COLORS[seg.field].bg,
                      borderBottom: `2px solid ${FIELD_COLORS[seg.field].border}`,
                    }}
                    className="rounded-sm"
                  >
                    {seg.text}
                  </span>
                ) : (
                  <span key={i} className="text-foreground">{seg.text}</span>
                )
              )}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Reading this as
            </p>
            <div className="flex flex-col gap-2">
              {fieldOrder.map(field => {
                const colors = FIELD_COLORS[field];
                const value = extraction[field];
                return (
                  <div
                    key={field}
                    className="flex gap-3 p-3 rounded-lg border border-border bg-background"
                    style={{ borderLeftWidth: 3, borderLeftColor: colors.border }}
                  >
                    <div
                      className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                      style={{ backgroundColor: colors.border }}
                    />
                    <div className="min-w-0">
                      <p
                        className="text-[11px] font-medium uppercase tracking-wide mb-0.5"
                        style={{ color: colors.border }}
                      >
                        {colors.label}
                      </p>
                      {value ? (
                        <p className="text-sm text-foreground">{value}</p>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">Not mentioned — add manually</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <button
            onClick={handleConfirm}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-foreground text-primary-foreground text-sm font-medium hover:bg-foreground/90 transition-colors"
          >
            Confirm &amp; continue <ArrowRight size={14} />
          </button>
        </>
      )}

      {text.trim().length > 0 && text.trim().length <= 20 && (
        <p className="text-xs text-muted-foreground italic">Keep typing — extraction begins after a complete sentence.</p>
      )}

      {isExtracting && (
        <p role="status" className="text-xs text-muted-foreground italic flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Reading your description…
        </p>
      )}

      {extractError && (
        <div role="alert" className="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800 leading-relaxed">
          {extractError}
        </div>
      )}
    </div>
  );
}

// ─── Structured wizard ────────────────────────────────────────────────────────

const STEP_LABELS = ["Data collected", "Purpose", "Third parties", "Retention"];

function StructuredWizard({
  onStepComplete
}: { onStepComplete: (step: 1 | 2 | 3 | 4, data: { tags?: DataTag[]; purpose?: string; thirdParties?: string; retention?: string }) => void }) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [tags, setTags] = useState<DataTag[]>([]);
  const [purpose, setPurpose] = useState("");
  const [thirdParties, setThirdParties] = useState("");
  const [retention, setRetention] = useState("");
  const [completed, setCompleted] = useState(new Set<number>());

  const advanceTo = (next: 1 | 2 | 3 | 4) => {
    if (!completed.has(step)) {
      const newCompleted = new Set(completed).add(step);
      setCompleted(newCompleted);
      if (step === 1) onStepComplete(1, { tags });
      if (step === 2) onStepComplete(2, { purpose });
      if (step === 3) onStepComplete(3, { thirdParties });
      if (step === 4) onStepComplete(4, { retention });
    }
    setStep(next);
  };

  // Only step 1 is required — a flow needs at least one data type to review.
  // Purpose, third parties, and retention can be genuinely blank for a real
  // flow (no third-party sharing, retention not yet decided, etc.), and the
  // findings generator already treats an empty field as "nothing to check"
  // rather than an error, so there's no reason to force text here.
  const canNext = step === 1 ? tags.length > 0 : true;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex justify-between text-xs text-muted-foreground mb-2">
          <span>Step {step} of 4 — {STEP_LABELS[step - 1]}</span>
        </div>
        <ProgressBar step={step} total={4} />
      </div>

      <div className="min-h-[200px]">
        {step === 1 && (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              What personal data is collected?
            </label>
            <p className="text-xs text-muted-foreground mb-3">Add each data type as a tag. Include fields from forms, cookies, logs, and inferences.</p>
            <TagInput tags={tags} onChange={setTags} />
          </div>
        )}
        {step === 2 && (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Why is this data collected?
            </label>
            <p className="text-xs text-muted-foreground mb-3">Describe the processing purpose in specific terms. "To improve UX" is not sufficient — be explicit about outcomes.</p>
            <textarea
              value={purpose}
              onChange={e => setPurpose(e.target.value)}
              placeholder="e.g. To personalise product recommendations based on browsing history and purchase intent, and to send transactional emails confirming orders."
              className="w-full h-36 p-3 text-sm bg-background border border-border rounded-lg resize-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground focus:border-foreground/30 placeholder:text-muted-foreground transition-colors leading-relaxed"
            />
          </div>
        )}
        {step === 3 && (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Who is this data shared with?
            </label>
            <p className="text-xs text-muted-foreground mb-3">List all third-party recipients — analytics, CDN, customer support platforms, ad networks, payment processors, etc.</p>
            <textarea
              value={thirdParties}
              onChange={e => setThirdParties(e.target.value)}
              placeholder="e.g. Stripe for payment processing, Google Analytics for usage analytics, Intercom for customer support, Meta Pixel for advertising attribution."
              className="w-full h-36 p-3 text-sm bg-background border border-border rounded-lg resize-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground focus:border-foreground/30 placeholder:text-muted-foreground transition-colors leading-relaxed"
            />
          </div>
        )}
        {step === 4 && (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              How long is the data retained?
            </label>
            <p className="text-xs text-muted-foreground mb-3">Describe the retention schedule, including any automated deletion or anonymisation that occurs after the period ends.</p>
            <textarea
              value={retention}
              onChange={e => setRetention(e.target.value)}
              placeholder="e.g. Account data is retained for 3 years after last login, then automatically deleted. Anonymised usage analytics are kept indefinitely. Billing records are kept for 7 years per tax obligations."
              className="w-full h-36 p-3 text-sm bg-background border border-border rounded-lg resize-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground focus:border-foreground/30 placeholder:text-muted-foreground transition-colors leading-relaxed"
            />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-border">
        <button
          onClick={() => step > 1 && setStep((step - 1) as 1|2|3|4)}
          disabled={step === 1}
          className="flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
        >
          <ChevronLeft size={14} /> Back
        </button>
        {step < 4 ? (
          <button
            onClick={() => advanceTo((step + 1) as 1|2|3|4)}
            disabled={!canNext}
            className="flex items-center gap-1 px-4 py-2 text-sm font-medium rounded-lg bg-foreground text-primary-foreground disabled:opacity-40 hover:bg-foreground/90 transition-colors"
          >
            Next <ChevronRight size={14} />
          </button>
        ) : (
          <button
            onClick={() => advanceTo(4)}
            disabled={!canNext || completed.has(4)}
            className="flex items-center gap-1 px-4 py-2 text-sm font-medium rounded-lg bg-foreground text-primary-foreground disabled:opacity-40 hover:bg-foreground/90 transition-colors"
          >
            {completed.has(4) ? <><Check size={13} /> Complete</> : <>Finish <ArrowRight size={14} /></>}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Review screen ────────────────────────────────────────────────────────────

function ReviewScreen({
  onDismissed
}: { onDismissed: (finding: Finding) => void }) {
  const [mode, setMode] = useState<InputMode>("structured");
  const [findings, setFindings] = useState<Finding[]>([]);
  // What retrieval considered, per step — kept so the findings panel can show
  // which clauses were in play, not just which ones produced a finding.
  const [retrievals, setRetrievals] = useState<Record<number, RetrievalResult | null>>({});
  const [dismissTarget, setDismissTarget] = useState<Finding | null>(null);
  const [reviewId] = useState(uid);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const handleStepComplete = async (step: 1|2|3|4, data: {
    tags?: DataTag[]; purpose?: string; thirdParties?: string; retention?: string;
  }) => {
    setIsAnalyzing(true);
    try {
      const result = await generateFindingsLLM(step, data, reviewId);
      setFindings(prev => [...prev, ...result.findings]);
      setRetrievals(prev => ({ ...prev, [step]: result.retrieval }));
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleFreeTextConfirm = async (data: { tags: DataTag[]; purpose: string; thirdParties: string; retention: string }) => {
    setIsAnalyzing(true);
    try {
      const results = await Promise.all([
        generateFindingsLLM(1, { tags: data.tags }, reviewId),
        generateFindingsLLM(2, { purpose: data.purpose }, reviewId),
        generateFindingsLLM(3, { thirdParties: data.thirdParties }, reviewId),
        generateFindingsLLM(4, { retention: data.retention }, reviewId),
      ]);
      setFindings(results.flatMap(r => r.findings));
      setRetrievals({
        1: results[0].retrieval, 2: results[1].retrieval,
        3: results[2].retrieval, 4: results[3].retrieval,
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const updateFinding = (id: string, updates: Partial<Finding>) => {
    setFindings(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));
  };

  const handleAccept = (id: string) => updateFinding(id, { status: "accepted" });

  const handleDismiss = (reason: DismissReason) => {
    if (!dismissTarget) return;
    const updated: Finding = { ...dismissTarget, status: "dismissed", dismissReason: reason };
    updateFinding(dismissTarget.id, { status: "dismissed", dismissReason: reason });
    onDismissed(updated);
    setDismissTarget(null);
  };

  const handleSendToLegal = (id: string) => updateFinding(id, { status: "accepted" });

  const switchMode = (m: InputMode) => {
    setMode(m);
    setFindings([]);
    setRetrievals({});
  };

  const stepLabels: Record<1|2|3|4, string> = {
    1: "Data collected", 2: "Purpose", 3: "Third parties", 4: "Retention"
  };

  const groupedFindings = useMemo(() => {
    const groups: Record<number, Finding[]> = { 1: [], 2: [], 3: [], 4: [] };
    for (const f of findings) groups[f.step].push(f);
    return groups;
  }, [findings]);

  return (
    <>
      {dismissTarget && (
        <DismissModal
          onConfirm={handleDismiss}
          onCancel={() => setDismissTarget(null)}
        />
      )}
      <div className="flex flex-col md:h-full">
        <div className="px-4 md:px-6 pt-5 md:pt-6 pb-4 border-b border-border">
          <h1 className="text-base font-medium text-foreground mb-3">New review</h1>
          <div role="group" aria-label="Input mode" className="inline-flex rounded-lg border border-border p-0.5 bg-muted gap-0.5">
            {(["structured", "freetext"] as InputMode[]).map(m => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                aria-pressed={mode === m}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${
                  mode === m
                    ? "bg-card text-foreground border border-border"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "structured" ? <Layers size={12} aria-hidden="true" /> : <AlignLeft size={12} aria-hidden="true" />}
                {m === "structured" ? "Structured" : "Free text"}
              </button>
            ))}
          </div>
        </div>

        {/* Stacks on mobile — form first, findings below it. Each pane only
            becomes an independent scroll region at md, where the shell has a
            fixed height for them to scroll within. */}
        <div className="flex flex-col md:flex-row flex-1 min-h-0">
          {/* Left: input form */}
          <div className="w-full md:w-[52%] border-b md:border-b-0 md:border-r border-border md:overflow-y-auto p-4 md:p-6 scrollbar-thin">
            {mode === "structured" ? (
              <StructuredWizard onStepComplete={handleStepComplete} />
            ) : (
              <FreeTextPanel onConfirm={handleFreeTextConfirm} />
            )}
          </div>

          {/* Right: findings panel */}
          <div className="flex-1 md:overflow-y-auto p-4 md:p-6 scrollbar-thin">
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4 flex items-center gap-2">
              Findings so far
              {isAnalyzing && <Loader2 size={12} className="animate-spin text-muted-foreground" aria-hidden="true" />}
            </h2>

            {/* Findings arrive asynchronously and the panel is far from the
                form the user is in. Without this, a screen-reader user gets no
                indication that anything happened. Polite so it waits for a
                pause rather than interrupting mid-typing. */}
            <div aria-live="polite" className="sr-only">
              {isAnalyzing
                ? "Checking this against the corpus."
                : findings.length > 0
                ? `${findings.length} finding${findings.length === 1 ? "" : "s"} so far.`
                : ""}
            </div>
            {findings.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-center">
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center mb-3">
                  {isAnalyzing ? (
                    <Loader2 size={16} className="text-muted-foreground animate-spin" />
                  ) : (
                    <FileText size={16} className="text-muted-foreground" />
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {isAnalyzing
                    ? "Checking this against the corpus…"
                    : mode === "structured"
                    ? "Complete a step to see findings appear here."
                    : "Confirm your extraction to see findings."}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {([1, 2, 3, 4] as const).map(s => {
                  const sf = groupedFindings[s];
                  if (sf.length === 0) return null;
                  const stepRetrieval = retrievals[s];
                  return (
                    <div key={s}>
                      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                        {stepLabels[s]}
                      </p>
                      {stepRetrieval && <RetrievalDisclosure retrieval={stepRetrieval} />}
                      <div className="flex flex-col gap-2">
                        {sf.map(f => (
                          <FindingCard
                            key={f.id}
                            finding={f}
                            onAccept={() => handleAccept(f.id)}
                            onDismiss={() => setDismissTarget(f)}
                            onSendToLegal={() => handleSendToLegal(f.id)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Review log ───────────────────────────────────────────────────────────────

function ReviewLog({ dismissed }: { dismissed: Finding[] }) {
  const [filter, setFilter] = useState<DismissReason | "all">("all");

  const filtered = filter === "all" ? dismissed : dismissed.filter(f => f.dismissReason === filter);
  const insight = useMemo(() => computeInsight(dismissed), [dismissed]);

  const reasonLabel: Record<DismissReason, string> = {
    "not-clause-relevant": "Not clause-relevant",
    "false-positive": "False positive",
    "already-handled": "Already handled elsewhere",
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <h1 className="text-base font-medium text-foreground mb-5">Review log</h1>

      {insight && (
        <div role="status" className="mb-5 p-4 rounded-lg border border-amber-200 bg-amber-50 flex items-start gap-3">
          <AlertTriangle size={15} className="text-amber-700 mt-0.5 shrink-0" aria-hidden="true" />
          <p className="text-sm text-amber-900 leading-relaxed">{insight}</p>
        </div>
      )}

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Filter size={13} className="text-muted-foreground" aria-hidden="true" />
        <span id="filter-label" className="text-xs text-muted-foreground font-medium">Filter by reason:</span>
        {/* aria-pressed rather than colour alone — the active filter is
            otherwise only distinguishable by background (WCAG 1.4.1). */}
        <div role="group" aria-labelledby="filter-label" className="flex items-center gap-2 flex-wrap">
          {(["all", "not-clause-relevant", "false-positive", "already-handled"] as const).map(r => (
            <button
              key={r}
              onClick={() => setFilter(r)}
              aria-pressed={filter === r}
              className={`px-2.5 py-1 rounded text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${
                filter === r
                  ? "bg-foreground text-primary-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-muted"
              }`}
            >
              {r === "all" ? "All" : reasonLabel[r]}
            </button>
          ))}
        </div>
      </div>

      {dismissed.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-muted-foreground">No dismissed findings yet.</p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No findings match this filter.</p>
      ) : (
        /* Horizontal scroll rather than squashing the table on narrow screens —
           reflow (WCAG 1.4.10) allows a data table to scroll in one direction.
           Plain block comment, not {/* … *​/} — this is an expression position,
           not a children position, so braces would be parsed as an object. */
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[480px]">
            <caption className="sr-only">Dismissed findings, with the regulation cited and the reason given</caption>
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th scope="col" className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Finding</th>
                <th scope="col" className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Regulation</th>
                <th scope="col" className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Reason</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((f, i) => (
                <tr key={f.id} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "" : "bg-muted/20"}`}>
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-sm text-foreground leading-snug">{f.explanation.slice(0, 80)}{f.explanation.length > 80 ? "…" : ""}</p>
                      {f.citation && (
                        <p className="text-xs text-muted-foreground mt-0.5">{f.citation}</p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <RegBadge reg={f.regulation} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-muted-foreground">
                      {f.dismissReason ? reasonLabel[f.dismissReason] : "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Corpus ───────────────────────────────────────────────────────────────────

function Corpus() {
  const grouped = useMemo(() => {
    const byReg: Record<string, typeof CORPUS> = {};
    for (const c of CORPUS) {
      if (!byReg[c.regulation]) byReg[c.regulation] = [];
      byReg[c.regulation].push(c);
    }
    return byReg;
  }, []);

  return (
    <div className="p-4 md:p-6 max-w-2xl">
      <h1 className="text-base font-medium text-foreground mb-1">Corpus</h1>
      <p className="text-sm text-muted-foreground mb-5">
        This is the actual set of clauses findings are grounded in — nothing else is cited.
        Coverage is intentionally scoped to what a product/design generalist runs into day to day,
        not the full text of any regulation. See each regulation's article list below.
      </p>
      <div className="flex flex-col gap-4">
        {Object.entries(grouped).map(([reg, clauses]) => (
          <div key={reg} className="p-4 bg-card border border-border rounded-lg">
            <p className="text-sm font-medium text-foreground mb-2">{reg}</p>
            <div className="flex flex-col gap-1.5">
              {clauses.map(c => (
                <div key={c.id} className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-muted-foreground">{c.article}</span>
                  <span className="text-xs text-foreground text-right">{c.title}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground italic mt-1">
          Anything outside this list returns "not clearly covered" rather than a guess.
        </p>
      </div>
    </div>
  );
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Retrieval evaluation, run live in the browser.
 *
 * This is a screen rather than a CLI script on purpose. Retrieval is
 * deterministic, so measuring it costs nothing and can run on every load —
 * which means the numbers are always current instead of being whatever was
 * pasted into a README months ago. It also makes the weakest part of the
 * pipeline the most visible one.
 */
function Evaluation() {
  const summary = useMemo(() => runRetrievalEval(DEFAULT_K), []);
  const curve = useMemo(() => recallCurve(), []);
  const [showPassing, setShowPassing] = useState(false);

  const failing = summary.cases.filter(c => !c.passed);
  const visible = showPassing ? summary.cases : failing;
  const maxRecall = Math.max(...curve.map(c => c.recall));

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <h1 className="text-base font-medium text-foreground mb-1">Retrieval evaluation</h1>
      <p className="text-sm text-muted-foreground mb-5 leading-relaxed">
        Retrieval sends only the top {DEFAULT_K} of {CORPUS.length} clauses to the model, so a clause
        that doesn't rank cannot be cited no matter how relevant it is. This measures how often the
        clause a reviewer would expect actually survives that cut. It runs client-side on every load
        and makes no model calls.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {[
          { label: "Recall", value: `${(summary.recall * 100).toFixed(1)}%`,
            sub: `${summary.expectedFound}/${summary.expectedTotal} clauses` },
          { label: "Cases fully covered", value: `${summary.casesPassed}/${summary.casesTotal}`,
            sub: "all expected clauses retrieved" },
          { label: "K", value: String(summary.k),
            sub: `of ${CORPUS.length} clauses sent` },
        ].map(stat => (
          <div key={stat.label} className="p-4 rounded-lg border border-border bg-card">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
              {stat.label}
            </p>
            <p className="text-xl font-medium text-foreground tabular-nums">{stat.value}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{stat.sub}</p>
          </div>
        ))}
      </div>

      <div className="mb-6 p-4 rounded-lg border border-border bg-card">
        <p className="text-xs font-medium text-foreground mb-1">Recall by K</p>
        <p className="text-[11px] text-muted-foreground mb-3 leading-snug">
          What raising K buys, against the token cost of sending more clauses. This curve is why
          K is {DEFAULT_K} — it is where the gain flattens.
        </p>
        <div className="flex flex-col gap-1.5">
          {curve.map(c => (
            <div key={c.k} className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-muted-foreground w-10 shrink-0">
                K={c.k}
              </span>
              <div className="flex-1 h-3.5 bg-muted rounded-sm overflow-hidden">
                <div
                  className={`h-full rounded-sm transition-all ${c.k === summary.k ? "bg-foreground" : "bg-border"}`}
                  style={{ width: `${(c.recall / maxRecall) * 100}%` }}
                />
              </div>
              <span className="text-[11px] font-mono text-muted-foreground w-12 shrink-0 text-right tabular-nums">
                {(c.recall * 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium text-foreground">
          {failing.length === 0 ? "No failing cases" : `${failing.length} failing case${failing.length === 1 ? "" : "s"}`}
        </p>
        <button
          onClick={() => setShowPassing(s => !s)}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {showPassing ? "Show failures only" : `Show all ${summary.casesTotal} cases`}
        </button>
      </div>

      <div className="flex flex-col gap-2 mb-6">
        {visible.map(c => (
          <div
            key={c.evalCase.id}
            className={`p-3 rounded-lg border bg-card ${c.passed ? "border-border" : "border-amber-200"}`}
          >
            <div className="flex items-start gap-2 mb-1">
              <span className={`text-[11px] font-medium shrink-0 ${c.passed ? "text-green-600" : "text-amber-700"}`}>
                {c.passed ? "pass" : "miss"}
              </span>
              <span className="text-[11px] font-mono text-muted-foreground">{c.evalCase.id}</span>
            </div>
            <p className="text-sm text-foreground leading-snug mb-1">{c.evalCase.input}</p>
            <p className="text-[11px] text-muted-foreground italic mb-1.5">{c.evalCase.rationale}</p>
            {c.missed.length > 0 && (
              <div className="flex flex-col gap-0.5">
                {c.missed.map(m => (
                  <p key={m.clauseId} className="text-[11px] text-amber-800">
                    expected <span className="font-medium">{m.label}</span> — ranked{" "}
                    {m.actualRank ?? "not at all"}
                    {m.actualRank ? `, below the top ${summary.k}` : ""}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="p-4 rounded-lg border border-border bg-muted/30">
        <p className="text-xs font-medium text-foreground mb-1.5">How to read 100%</p>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Cautiously. These {summary.casesTotal} cases were written first and the scoring was then
          tuned until they passed — which is what an evaluation set is for, but it means this number
          measures fit to a set of my own labels, not generalisation. Recall started at 66.7% and
          each fix was a response to a specific failure: per-clause synonyms for the gap between
          product vocabulary and statutory vocabulary, then pinning for obligations that apply
          regardless of wording. The honest next step is held-out cases written after the tuning,
          which is where the real number is. Labels are a designer's reading of the clauses, not
          legal ground truth.
        </p>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

const NAV_ITEMS: { screen: Screen; label: string; icon: React.ReactNode }[] = [
  { screen: "review",  label: "New review",  icon: <FileText size={15} /> },
  { screen: "log",     label: "Review log",  icon: <ClipboardList size={15} /> },
  { screen: "corpus",  label: "Corpus",      icon: <BookOpen size={15} /> },
  { screen: "eval",    label: "Evaluation",  icon: <Target size={15} /> },
];

export default function App() {
  const [screen, setScreen] = useState<Screen>("review");
  const [dismissed, setDismissed] = useState<Finding[]>([]);
  const [reviewKey, setReviewKey] = useState(0);

  const handleNavClick = (s: Screen) => {
    if (s === "review") setReviewKey(k => k + 1);
    setScreen(s);
  };

  return (
    // Layout inverts at md. Below it the app is a normal scrolling page with a
    // stacked header and nav; at md and up it becomes the fixed-height,
    // independently-scrolling two-column shell the design assumes. Locking
    // h-screen/overflow-hidden at every width is what made this desktop-only.
    <div
      className="flex flex-col md:flex-row min-h-screen md:h-screen md:overflow-hidden bg-background"
      style={{ fontFamily: "var(--font-family)" }}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-3 focus:py-2 focus:rounded-lg focus:bg-foreground focus:text-primary-foreground focus:text-sm"
      >
        Skip to main content
      </a>

      {/* Sidebar — a horizontal, scrollable nav bar on mobile */}
      <aside className="w-full md:w-52 shrink-0 bg-sidebar border-b md:border-b-0 md:border-r border-sidebar-border flex flex-col">
        <div className="px-4 py-4 md:py-5 border-b border-sidebar-border">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-foreground flex items-center justify-center shrink-0">
              <Send size={11} className="text-primary-foreground rotate-[-20deg]" aria-hidden="true" />
            </div>
            <span className="text-sm font-medium text-foreground">Privacy Review</span>
          </div>
        </div>
        <nav aria-label="Main" className="flex flex-row md:flex-col gap-0.5 px-2 py-2 md:pt-3 overflow-x-auto md:overflow-x-visible">
          {NAV_ITEMS.map(item => (
            <button
              key={item.screen}
              onClick={() => handleNavClick(item.screen)}
              aria-current={screen === item.screen ? "page" : undefined}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left shrink-0 md:w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${
                screen === item.screen
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
            >
              <span aria-hidden="true" className="shrink-0">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        {/* Hidden on mobile — in a horizontal bar it would push the nav
            off-screen. The same disclaimer is repeated at the foot of the
            main column at that width. */}
        <div className="hidden md:block mt-auto px-4 py-4 border-t border-sidebar-border">
          <p className="text-[11px] text-muted-foreground leading-snug">Pre-legal screening only. Not a substitute for legal review.</p>
        </div>
      </aside>

      {/* Main content */}
      <main id="main-content" className="flex-1 md:overflow-hidden flex flex-col min-h-0">
        {screen === "review" && (
          <ReviewScreen key={reviewKey} onDismissed={f => setDismissed(prev => [...prev, f])} />
        )}
        {screen === "log" && (
          <div className="md:overflow-y-auto flex-1 scrollbar-thin">
            <ReviewLog dismissed={dismissed} />
          </div>
        )}
        {screen === "corpus" && (
          <div className="md:overflow-y-auto flex-1 scrollbar-thin">
            <Corpus />
          </div>
        )}
        {screen === "eval" && (
          <div className="md:overflow-y-auto flex-1 scrollbar-thin">
            <Evaluation />
          </div>
        )}

        {/* Mobile-only echo of the sidebar disclaimer, which is hidden at this width. */}
        <p className="md:hidden px-4 py-4 text-[11px] text-muted-foreground leading-snug border-t border-border">
          Pre-legal screening only. Not a substitute for legal review.
        </p>
      </main>
    </div>
  );
}
