import React, { useState, useRef, useEffect, KeyboardEvent, useMemo } from "react";
import {
  Plus, X, ChevronRight, ChevronLeft,
  FileText, ClipboardList, BookOpen,
  AlertTriangle, Send, Filter, Layers, AlignLeft,
  Check, ArrowRight, Loader2
} from "lucide-react";
import { CORPUS } from "../lib/corpus";
import { callClaudeJSON } from "../lib/anthropicClient";

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen = "review" | "log" | "corpus";
type InputMode = "structured" | "freetext";
type FindingVariant = "grounded" | "low-confidence" | "not-covered" | "error";
type FindingStatus = "pending" | "accepted" | "dismissed";
type DismissReason = "not-clause-relevant" | "false-positive" | "already-handled";
type FieldKey = "dataCollected" | "purpose" | "thirdParties" | "retention";

interface DataTag { id: string; label: string; }

interface Finding {
  id: string;
  variant: FindingVariant;
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

interface RawFinding {
  variant: FindingVariant;
  category: string;
  explanation: string;
  clause_id: string | null;
}

const FINDINGS_SYSTEM_PROMPT = `You are a privacy-compliance reviewer assistant. You are given a slice of a
product flow description and a small corpus of real regulation clauses.

Rules you must follow exactly:
- Only cite a clause_id that appears in the corpus provided to you. Never invent a clause id or citation.
- If nothing in the corpus clearly applies to the input, return a single finding with variant "not-covered",
  clause_id null, category "Not clearly covered", and an explanation of what would need legal review.
- Use variant "grounded" only when a corpus clause clearly and directly applies.
- Use variant "low-confidence" when a corpus clause plausibly applies but the input is ambiguous.
- Do not guess facts not present in the input. Do not pad with filler findings.
- Return 0-3 findings maximum for this input.
- Respond with ONLY a JSON array, no prose, no markdown fences. Each item:
  { "variant": "grounded" | "low-confidence" | "not-covered", "category": string, "explanation": string, "clause_id": string | null }`;

async function generateFindingsLLM(
  step: 1 | 2 | 3 | 4,
  data: { tags?: DataTag[]; purpose?: string; thirdParties?: string; retention?: string },
  reviewId: string
): Promise<Finding[]> {
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
    return [];
  }

  const corpusBlock = CORPUS.map(
    c => `clause_id: ${c.id}\nregulation: ${c.regulation}\narticle: ${c.article} — ${c.title}\ntext: ${c.text}`
  ).join("\n\n---\n\n");

  const userMessage = `CORPUS:\n${corpusBlock}\n\nFLOW INPUT (step ${step}):\n${stepInput}`;

  let raw: RawFinding[];
  try {
    raw = await callClaudeJSON<RawFinding[]>(FINDINGS_SYSTEM_PROMPT, userMessage);
  } catch (e) {
    return [{
      id: uid(), variant: "error", category: "Analysis unavailable",
      explanation: e instanceof Error ? e.message : "Could not reach the model.",
      regulation: "—", status: "pending", step, reviewId,
    }];
  }

  return raw.map(r => {
    const clause = r.clause_id ? CORPUS.find(c => c.id === r.clause_id) : undefined;
    return {
      id: uid(),
      variant: r.variant,
      category: r.category,
      explanation: r.explanation,
      citation: clause ? `${clause.regulation} ${clause.article} — ${clause.title}` : undefined,
      regulation: clause?.regulation ?? "—",
      status: "pending" as FindingStatus,
      step,
      reviewId,
    };
  });
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
  return `${best.count} of ${best.total} dismissals on "${best.clause}" were marked "not clause-relevant" — this clause may be over-triggering in retrieval.`;
}

// ─── UI primitives ────────────────────────────────────────────────────────────

function VariantBadge({ variant, category }: { variant: FindingVariant; category: string }) {
  const cls =
    variant === "grounded"
      ? "bg-red-50 text-red-700 border border-red-200"
      : variant === "low-confidence"
      ? "bg-amber-50 text-amber-700 border border-amber-200"
      : variant === "error"
      ? "bg-transparent text-gray-400 border border-dashed border-gray-300"
      : "bg-gray-100 text-gray-500 border border-gray-200";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
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
        {finding.status === "accepted" && (
          <span className="ml-auto text-[11px] text-green-600 font-medium flex items-center gap-0.5">
            <Check size={11} /> Accepted
          </span>
        )}
        {finding.status === "dismissed" && (
          <span className="ml-auto text-[11px] text-gray-400 font-medium">Dismissed</span>
        )}
      </div>
      <p className="text-sm text-foreground leading-relaxed mb-2">{finding.explanation}</p>
      {finding.citation && (
        <p className="text-xs text-muted-foreground font-medium mb-3">{finding.citation}</p>
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
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-border text-muted-foreground hover:bg-muted transition-colors"
        >
          <Send size={11} /> Send to legal
        </button>
      )}
      {finding.variant === "error" && (
        <p className="text-xs text-gray-400 italic">
          Not a finding — the model couldn't be reached. Nothing to accept or dismiss here.
        </p>
      )}
    </div>
  );
}

function DismissModal({
  onConfirm, onCancel
}: { onConfirm: (reason: DismissReason) => void; onCancel: () => void }) {
  const [selected, setSelected] = useState<DismissReason | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <div className="bg-card border border-border rounded-xl p-6 w-full max-w-sm mx-4">
        <h3 className="text-sm font-medium text-foreground mb-1">Dismiss finding</h3>
        <p className="text-xs text-muted-foreground mb-4">Select a reason before dismissing.</p>
        <div className="flex flex-col gap-2 mb-5">
          {DISMISS_REASONS.map(r => (
            <button
              key={r.value}
              onClick={() => setSelected(r.value)}
              className={`text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${
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
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => selected && onConfirm(selected)}
            disabled={!selected}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-foreground text-primary-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-foreground/90 transition-colors"
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
            <button
              onClick={(e) => { e.stopPropagation(); removeTag(tag.id); }}
              className="hover:text-destructive transition-colors"
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={onKey}
          placeholder={tags.length === 0 ? "Type a data type and press Enter…" : "Add another…"}
          className="flex-1 min-w-[140px] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
        />
      </div>
      {(typingSensitive || sensitiveTags.length > 0) && (
        <div className="mt-2 flex items-start gap-1.5 p-2.5 rounded-lg border border-amber-200 bg-amber-50">
          <AlertTriangle size={13} className="text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800">
            {typingSensitive
              ? `"${val}" looks like a sensitive category.`
              : `${sensitiveTags.map(t => t.label).join(", ")} ${sensitiveTags.length === 1 ? "is" : "are"} a sensitive category.`}
            {" "}This may require a higher legal basis (explicit consent or Art. 9 exception) under GDPR, and HIPAA may apply.
          </p>
        </div>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">Press Enter to add each type. Sensitive types are highlighted.</p>
    </div>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex gap-1">
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
          className="w-full h-40 p-3 text-sm bg-background border border-border rounded-lg resize-none outline-none focus:border-foreground/30 placeholder:text-muted-foreground transition-colors leading-relaxed"
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
        <p className="text-xs text-muted-foreground italic flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Reading your description…
        </p>
      )}

      {extractError && (
        <div className="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800 leading-relaxed">
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
              className="w-full h-36 p-3 text-sm bg-background border border-border rounded-lg resize-none outline-none focus:border-foreground/30 placeholder:text-muted-foreground transition-colors leading-relaxed"
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
              className="w-full h-36 p-3 text-sm bg-background border border-border rounded-lg resize-none outline-none focus:border-foreground/30 placeholder:text-muted-foreground transition-colors leading-relaxed"
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
              className="w-full h-36 p-3 text-sm bg-background border border-border rounded-lg resize-none outline-none focus:border-foreground/30 placeholder:text-muted-foreground transition-colors leading-relaxed"
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
  const [dismissTarget, setDismissTarget] = useState<Finding | null>(null);
  const [reviewId] = useState(uid);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const handleStepComplete = async (step: 1|2|3|4, data: {
    tags?: DataTag[]; purpose?: string; thirdParties?: string; retention?: string;
  }) => {
    setIsAnalyzing(true);
    try {
      const newFindings = await generateFindingsLLM(step, data, reviewId);
      setFindings(prev => [...prev, ...newFindings]);
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
      setFindings(results.flat());
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
      <div className="flex flex-col h-full">
        <div className="px-6 pt-6 pb-4 border-b border-border">
          <h1 className="text-base font-medium text-foreground mb-3">New review</h1>
          <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted gap-0.5">
            {(["structured", "freetext"] as InputMode[]).map(m => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  mode === m
                    ? "bg-card text-foreground border border-border"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "structured" ? <Layers size={12} /> : <AlignLeft size={12} />}
                {m === "structured" ? "Structured" : "Free text"}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Left: input form */}
          <div className="w-[52%] border-r border-border overflow-y-auto p-6 scrollbar-thin">
            {mode === "structured" ? (
              <StructuredWizard onStepComplete={handleStepComplete} />
            ) : (
              <FreeTextPanel onConfirm={handleFreeTextConfirm} />
            )}
          </div>

          {/* Right: findings panel */}
          <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4 flex items-center gap-2">
              Findings so far
              {isAnalyzing && <Loader2 size={12} className="animate-spin text-muted-foreground" />}
            </h2>
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
                  return (
                    <div key={s}>
                      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                        {stepLabels[s]}
                      </p>
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
    <div className="p-6 max-w-3xl">
      <h1 className="text-base font-medium text-foreground mb-5">Review log</h1>

      {insight && (
        <div className="mb-5 p-4 rounded-lg border border-amber-200 bg-amber-50 flex items-start gap-3">
          <AlertTriangle size={15} className="text-amber-600 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-900 leading-relaxed">{insight}</p>
        </div>
      )}

      <div className="flex items-center gap-2 mb-4">
        <Filter size={13} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground font-medium">Filter by reason:</span>
        {(["all", "not-clause-relevant", "false-positive", "already-handled"] as const).map(r => (
          <button
            key={r}
            onClick={() => setFilter(r)}
            className={`px-2.5 py-1 rounded text-xs transition-colors ${
              filter === r
                ? "bg-foreground text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-muted"
            }`}
          >
            {r === "all" ? "All" : reasonLabel[r]}
          </button>
        ))}
      </div>

      {dismissed.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-muted-foreground">No dismissed findings yet.</p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No findings match this filter.</p>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Finding</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Regulation</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Reason</th>
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
    <div className="p-6 max-w-2xl">
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

// ─── App ──────────────────────────────────────────────────────────────────────

const NAV_ITEMS: { screen: Screen; label: string; icon: React.ReactNode }[] = [
  { screen: "review",  label: "New review",  icon: <FileText size={15} /> },
  { screen: "log",     label: "Review log",  icon: <ClipboardList size={15} /> },
  { screen: "corpus",  label: "Corpus",      icon: <BookOpen size={15} /> },
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
    <div className="flex h-screen overflow-hidden bg-background" style={{ fontFamily: "var(--font-family)" }}>
      {/* Sidebar */}
      <aside className="w-52 shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
        <div className="px-4 py-5 border-b border-sidebar-border">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-foreground flex items-center justify-center">
              <Send size={11} className="text-primary-foreground rotate-[-20deg]" />
            </div>
            <span className="text-sm font-medium text-foreground">Privacy Review</span>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2 pt-3">
          {NAV_ITEMS.map(item => (
            <button
              key={item.screen}
              onClick={() => handleNavClick(item.screen)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left w-full ${
                screen === item.screen
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto px-4 py-4 border-t border-sidebar-border">
          <p className="text-[11px] text-muted-foreground leading-snug">Pre-legal screening only. Not a substitute for legal review.</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-hidden flex flex-col">
        {screen === "review" && (
          <ReviewScreen key={reviewKey} onDismissed={f => setDismissed(prev => [...prev, f])} />
        )}
        {screen === "log" && (
          <div className="overflow-y-auto flex-1 scrollbar-thin">
            <ReviewLog dismissed={dismissed} />
          </div>
        )}
        {screen === "corpus" && (
          <div className="overflow-y-auto flex-1 scrollbar-thin">
            <Corpus />
          </div>
        )}
      </main>
    </div>
  );
}
