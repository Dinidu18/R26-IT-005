// src/pages/WaterQualityReport.jsx
// Step 4 — reads Level 1/2 (arrays of ALL detected labels) and Level 3 output
// from props, generates the report, shows a top-of-report safety status
// derived from the report content, lets the user download a formatted PDF,
// and calculates chemical dosages scaled to a user-entered water volume.
import { useState, useMemo } from "react";
import jsPDF from "jspdf";
import {
  Droplets,
  FlaskConical,
  Microscope,
  Waves,
  Loader2,
  AlertTriangle,
  FileText,
  Download,
  Beaker,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";

const API_BASE = import.meta.env?.VITE_REPORT_API_BASE || "http://localhost:5003";

const QUALITY_STYLES = {
  Excellent: "border-emerald-200 bg-emerald-50 text-emerald-600",
  Good: "border-emerald-200 bg-emerald-50 text-emerald-600",
  Poor: "border-amber-200 bg-amber-50 text-amber-600",
  Unsafe: "border-red-200 bg-red-50 text-red-600",
};

// RGB triples (jsPDF wants numeric r,g,b, not hex strings)
const QUALITY_RGB = {
  Excellent: [8, 145, 178],
  Good: [5, 150, 105],
  Poor: [217, 119, 6],
  Unsafe: [220, 38, 38],
};

const SKY = [3, 105, 161]; // #0369a1
const SLATE_DARK = [30, 41, 59]; // #1e293b
const SLATE_MUTED = [100, 116, 139]; // #64748b
const SLATE_LIGHT_BG = [248, 250, 252]; // #f8fafc
const SLATE_BORDER = [226, 232, 240]; // #e2e8f0
const RED = [220, 38, 38];
const GREEN = [5, 150, 105];

const NO_CONTAM = "No Contamination";
const NO_ORGANISM = "No microscopic aquatic organisms";

function inlineFormat(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={`${keyPrefix}-${i}`} className="font-semibold text-slate-900">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={`${keyPrefix}-${i}`}>{part}</span>
    )
  );
}

function MarkdownReport({ markdown }) {
  const lines = markdown.split("\n");
  const blocks = [];
  let listBuffer = [];
  let listType = null;

  const flushList = (key) => {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];
    const Tag = listType === "ol" ? "ol" : "ul";
    blocks.push(
      <Tag key={`list-${key}`} className={`my-2.5 space-y-1.5 pl-5 text-sm text-slate-700 text-justify ${listType === "ol" ? "list-decimal" : "list-disc"}`}>
        {items.map((item, i) => (
          <li key={i}>{inlineFormat(item, `li-${key}-${i}`)}</li>
        ))}
      </Tag>
    );
    listType = null;
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (trimmed === "") {
      flushList(idx);
      return;
    }
    if (trimmed.startsWith("# ")) {
      flushList(idx);
      blocks.push(
        <h1 key={idx} className="mb-3 text-xl font-bold tracking-tight text-sky-700">
          {trimmed.slice(2)}
        </h1>
      );
      return;
    }
    if (trimmed.startsWith("## ")) {
      flushList(idx);
      blocks.push(
        <h2 key={idx} className="mb-2 mt-6 border-b border-slate-200 pb-1.5 text-sm font-bold uppercase tracking-wide text-slate-700 first:mt-0">
          {trimmed.slice(3)}
        </h2>
      );
      return;
    }
    // Sub-headings the LLM occasionally emits inside a section — render as
    // a smaller heading instead of falling through to a literal "### " line.
    if (trimmed.startsWith("### ")) {
      flushList(idx);
      blocks.push(
        <h3 key={idx} className="mb-1.5 mt-4 text-[13px] font-bold text-slate-600">
          {trimmed.slice(4)}
        </h3>
      );
      return;
    }
    // Catch-all for any deeper heading levels (####, #####, ...) so they
    // never render with literal leading hashes either.
    const deepHeading = trimmed.match(/^#{4,6}\s+(.*)$/);
    if (deepHeading) {
      flushList(idx);
      blocks.push(
        <h4 key={idx} className="mb-1 mt-3 text-[12px] font-bold text-slate-500">
          {deepHeading[1]}
        </h4>
      );
      return;
    }
    const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      if (listType !== "ol") flushList(idx);
      listType = "ol";
      listBuffer.push(numbered[1]);
      return;
    }
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      if (listType !== "ul") flushList(idx);
      listType = "ul";
      listBuffer.push(trimmed.slice(2));
      return;
    }
    flushList(idx);
    blocks.push(
      <p key={idx} className="my-2 text-sm leading-relaxed text-justify text-slate-700">
        {inlineFormat(trimmed, `p-${idx}`)}
      </p>
    );
  });
  flushList("end");

  return <div>{blocks}</div>;
}

function LabelChips({ labels, emptyText }) {
  if (!labels || labels.length === 0 || (labels.length === 1 && (labels[0] === NO_CONTAM || labels[0] === NO_ORGANISM))) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-600">
        ✅ {emptyText}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {labels.map((l) => (
        <span
          key={l}
          className="inline-block rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700"
        >
          {l}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Safety status — derived primarily from the generated report's own wording
// (its "Final Verdict" section), falling back to the detected labels /
// danger flags / quality classification if the wording can't be matched.
// ---------------------------------------------------------------------------

function determineStatus(report, { level1Labels, level2Labels, quality, dangerFlags }) {
  const hasContamination = (level1Labels || []).some((l) => l !== NO_CONTAM);
  const hasOrganism = (level2Labels || []).some((l) => l !== NO_ORGANISM);
  const hasFlags = (dangerFlags || []).length > 0;
  const poorQuality = quality === "Poor" || quality === "Unsafe";
  const fallbackUnsafe = hasContamination || hasOrganism || hasFlags || poorQuality;

  if (!report) {
    return {
      safe: !fallbackUnsafe,
      source: "pipeline",
      reasons: { hasContamination, hasOrganism, hasFlags, poorQuality },
    };
  }

  const lower = report.toLowerCase();
  let sectionText = lower;
  const verdictIdx = lower.search(/final verdict[^\n]*\n/);
  if (verdictIdx !== -1) sectionText = lower.slice(verdictIdx);

  const unsafePatterns = [
    /not safe/,
    /not suitable/,
    /\bunsafe\b/,
    /not recommended/,
    /requires? (immediate )?treatment/,
    /not fit for/,
    /needs? (further )?treatment/,
    /is not safe/,
  ];
  const safePatterns = [
    /safe to drink/,
    /suitable for drinking/,
    /safe for (human )?consumption/,
    /\bis safe\b/,
    /water is safe/,
  ];

  const hasUnsafeWording = unsafePatterns.some((p) => p.test(sectionText));
  const hasSafeWording = !hasUnsafeWording && safePatterns.some((p) => p.test(sectionText));

  if (hasUnsafeWording) {
    return { safe: false, source: "report", reasons: { hasContamination, hasOrganism, hasFlags, poorQuality } };
  }
  if (hasSafeWording) {
    return { safe: true, source: "report", reasons: { hasContamination, hasOrganism, hasFlags, poorQuality } };
  }
  return { safe: !fallbackUnsafe, source: "pipeline", reasons: { hasContamination, hasOrganism, hasFlags, poorQuality } };
}

function StatusBanner({ status, level1Labels, level2Labels, dangerFlags }) {
  const { safe, reasons } = status;
  const reasonChips = [];
  if (reasons.hasContamination) reasonChips.push(...level1Labels.filter((l) => l !== NO_CONTAM));
  if (reasons.hasOrganism) reasonChips.push(...level2Labels.filter((l) => l !== NO_ORGANISM));
  if (reasons.hasFlags) reasonChips.push(...dangerFlags.map((f) => `${f} out of range`));

  return (
    <div
      className={`rounded-xl border p-4 flex items-start gap-3 ${
        safe ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"
      }`}
    >
      {safe ? (
        <ShieldCheck className="w-7 h-7 text-emerald-600 shrink-0" />
      ) : (
        <ShieldAlert className="text-red-600 w-7 h-7 shrink-0" />
      )}
      <div className="min-w-0">
        <div className={`text-sm font-bold uppercase tracking-wide ${safe ? "text-emerald-700" : "text-red-700"}`}>
          {safe ? "Water Status: Safe" : "Water Status: Not Safe — Treatment Required"}
        </div>
        <p className={`mt-0.5 text-[13px] ${safe ? "text-emerald-700/80" : "text-red-700/80"}`}>
          {safe
            ? "No significant contamination, organisms, or out-of-range parameters were detected."
            : reasonChips.length > 0
            ? `Based on: ${reasonChips.join(", ")}.`
            : "The report indicates this water is not currently safe to drink."}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chemical dosage extraction + scaling
// ---------------------------------------------------------------------------

const UNIT_LABELS = {
  ml: "mL",
  mL: "mL",
  l: "L",
  L: "L",
  g: "g",
  mg: "mg",
  drop: "drop",
  drops: "drops",
  tablet: "tablet",
  tablets: "tablets",
  tsp: "tsp",
  tbsp: "tbsp",
};

// Finds the backend's fixed dosage line — "Chemical Dosage (per 1 L of
// water): <chemical>: <dose>[, instructions]" — anywhere in the report, and
// pulls out amount + unit tokens so the dose can be scaled. Handles both a
// single chemical on that line and multiple chemicals separated by ";".
// Falls back to old-style bullet lines ("- Name: dose ... per 1 L") in case
// the backend ever emits a multi-bullet list instead of one merged line.
function extractDosages(markdown) {
  if (!markdown) return [];
  const lines = markdown.split("\n");
  const dosages = [];

  const parsePiece = (piece) => {
    const colonIdx = piece.indexOf(":");
    if (colonIdx === -1) return null;
    const name = piece.slice(0, colonIdx).replace(/^[-*]\s*/, "").trim();
    const desc = piece.slice(colonIdx + 1).trim();
    if (!name || !desc) return null;

    const tokenRegex = /(~?\s*)([\d]*\.?[\d]+)\s*(mL|ml|L|l|drops?|drop|tablets?|tablet|g|mg|tsp|tbsp)\b/g;
    const components = [];
    let m;
    while ((m = tokenRegex.exec(desc)) !== null) {
      components.push({
        approx: m[1].includes("~"),
        amount: parseFloat(m[2]),
        unit: UNIT_LABELS[m[3]] || m[3],
      });
    }
    if (components.length === 0) return null;

    const instrMatch = desc.match(/per\s*1\s*L\s*,\s*(.+)$/i);
    const instructions = instrMatch ? instrMatch[1].replace(/\.$/, "").trim() || null : null;

    return { name, components, instructions };
  };

  lines.forEach((raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    // Primary case: the exact header the backend always writes.
    const headerMatch = trimmed.match(/^\**\s*Chemical Dosage\s*\(per\s*1\s*L of water\)\s*:\s*/i);
    if (headerMatch) {
      const rest = trimmed.slice(headerMatch[0].length).trim();
      if (!rest || /not applicable/i.test(rest)) return;
      rest.split(/;\s*/).forEach((piece) => {
        const parsed = parsePiece(piece);
        if (parsed) dosages.push(parsed);
      });
      return;
    }

    // Fallback: an old-style bullet line elsewhere in the doc.
    if ((trimmed.startsWith("- ") || trimmed.startsWith("* ")) && /per\s*1\s*L\b/i.test(trimmed)) {
      const parsed = parsePiece(trimmed.replace(/^[-*]\s*/, ""));
      if (parsed) dosages.push(parsed);
    }
  });

  return dosages;
}

function formatAmount(n) {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(n < 1 ? 2 : 1).replace(/\.?0+$/, (s) => (s === "." ? "" : s));
}

function DosageCalculator({ dosages }) {
  const [liters, setLiters] = useState("1");
  const litersNum = Math.max(0, Number(liters) || 0);

  return (
    <div className="p-5 bg-white border shadow-sm rounded-xl border-slate-200">
      <h2 className="mb-1 text-xs font-semibold tracking-widest uppercase text-slate-500">
        <Beaker className="inline-block w-3.5 h-3.5 mb-0.5 mr-1.5" />
        Chemical Dosage Calculator
      </h2>
      <p className="mb-4 text-[12px] text-slate-400">
        Enter how much water you're treating — doses scale from the report's per-1&nbsp;L recommendation.
      </p>

      <label className="block mb-1.5 text-xs font-semibold text-slate-600">
        Water volume to treat (litres)
      </label>
      <input
        type="number"
        min="0"
        step="0.1"
        value={liters}
        onChange={(e) => setLiters(e.target.value)}
        className="w-full mb-5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
        placeholder="e.g. 5"
      />

      <div className="space-y-3">
        {dosages.map((d, i) => (
          <div key={i} className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
            <div className="mb-2 text-sm font-semibold text-sky-700">{d.name}</div>

            <div className="grid grid-cols-2 gap-3">
              <div className="px-3 py-2 bg-white border rounded-md border-slate-200">
                <div className="text-[10px] uppercase tracking-wide text-slate-400">Per 1 L (reference)</div>
                <div className="text-sm font-semibold text-slate-600">
                  {d.components.map((c, j) => (
                    <span key={j}>
                      {j > 0 && " + "}
                      {c.approx && "~"}
                      {formatAmount(c.amount)} {c.unit}
                    </span>
                  ))}
                </div>
              </div>
              <div className="px-3 py-2 border rounded-md bg-emerald-50 border-emerald-200">
                <div className="text-[10px] uppercase tracking-wide text-emerald-600">
                  For {litersNum || 0} L
                </div>
                <div className="text-sm font-bold text-emerald-700">
                  {litersNum > 0
                    ? d.components.map((c, j) => (
                        <span key={j}>
                          {j > 0 && " + "}
                          {c.approx && "~"}
                          {formatAmount(c.amount * litersNum)} {c.unit}
                        </span>
                      ))
                    : "—"}
                </div>
              </div>
            </div>

            {d.instructions && (
              <p className="mt-2 text-[11.5px] text-slate-500 italic">{d.instructions}</p>
            )}
          </div>
        ))}
      </div>

      <p className="mt-4 text-[11px] text-slate-400">
        ⚠ Reference only — verify against product label instructions and local water-safety guidance before use.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PDF generation helpers
// ---------------------------------------------------------------------------

const PAGE_W = 595.28; // A4 pt
const PAGE_H = 841.89;
const MARGIN = 42;
const CONTENT_W = PAGE_W - MARGIN * 2;

function addFooter(doc, pageNum) {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...SLATE_MUTED);
  doc.text(`AquaCheck — Water Quality Report`, MARGIN, PAGE_H - 24);
  doc.text(`Page ${pageNum}`, PAGE_W - MARGIN, PAGE_H - 24, { align: "right" });
}

function newPage(doc, pageNumRef) {
  doc.addPage();
  pageNumRef.n += 1;
  addFooter(doc, pageNumRef.n);
  return MARGIN + 10;
}

function ensureSpace(doc, y, needed, pageNumRef) {
  if (y + needed > PAGE_H - MARGIN - 20) {
    return newPage(doc, pageNumRef);
  }
  return y;
}

function tokenizeInline(text) {
  const segments = text.split(/(\*\*[^*]+\*\*)/g);
  const tokens = [];
  segments.forEach((seg) => {
    if (!seg) return;
    const bold = seg.startsWith("**") && seg.endsWith("**");
    const clean = bold ? seg.slice(2, -2) : seg;
    clean.split(/(\s+)/).forEach((w) => {
      if (w === "") return;
      tokens.push({ text: w, bold });
    });
  });
  return tokens;
}

function renderParagraph(doc, text, x, y, maxWidth, opts, pageNumRef) {
  const { fontSize = 10, lineHeight = 14, color = SLATE_DARK, indent = 0 } = opts;
  const tokens = tokenizeInline(text);
  let curX = x + indent;
  let curY = y;
  doc.setFontSize(fontSize);
  doc.setTextColor(...color);

  tokens.forEach((tok) => {
    doc.setFont("helvetica", tok.bold ? "bold" : "normal");
    const w = doc.getTextWidth(tok.text);
    if (tok.text.trim() !== "" && curX + w > x + indent + maxWidth - indent) {
      curY += lineHeight;
      curX = x + indent;
      curY = ensureSpace(doc, curY, lineHeight, pageNumRef);
    }
    if (tok.text.trim() !== "") {
      doc.text(tok.text, curX, curY);
    }
    curX += w;
  });

  return curY + lineHeight;
}

function renderMarkdownToPdf(doc, markdown, startY, pageNumRef) {
  let y = startY;
  const lines = markdown.split("\n");

  lines.forEach((raw) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      y += 6;
      return;
    }

    if (trimmed.startsWith("# ")) {
      y = ensureSpace(doc, y, 30, pageNumRef);
      y += 8;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.setTextColor(...SKY);
      doc.text(trimmed.slice(2), MARGIN, y);
      y += 8;
      doc.setDrawColor(...SLATE_BORDER);
      doc.setLineWidth(1);
      doc.line(MARGIN, y, PAGE_W - MARGIN, y);
      y += 16;
      return;
    }

    if (trimmed.startsWith("## ")) {
      y = ensureSpace(doc, y, 26, pageNumRef);
      y += 14;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11.5);
      doc.setTextColor(...SLATE_DARK);
      doc.text(trimmed.slice(3).toUpperCase(), MARGIN, y);
      y += 5;
      doc.setDrawColor(...SLATE_BORDER);
      doc.setLineWidth(0.75);
      doc.line(MARGIN, y, PAGE_W - MARGIN, y);
      y += 12;
      return;
    }

    // Sub-headings ("### ...") — smaller, no underline, no uppercasing.
    if (trimmed.startsWith("### ")) {
      y = ensureSpace(doc, y, 20, pageNumRef);
      y += 10;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...SKY);
      doc.text(trimmed.slice(4), MARGIN, y);
      y += 10;
      return;
    }

    // Any deeper heading level (####, #####, ...) — treat the same as a
    // sub-heading so no literal hash marks ever reach the PDF.
    const deepHeading = trimmed.match(/^#{4,6}\s+(.*)$/);
    if (deepHeading) {
      y = ensureSpace(doc, y, 18, pageNumRef);
      y += 8;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.5);
      doc.setTextColor(...SLATE_MUTED);
      doc.text(deepHeading[1], MARGIN, y);
      y += 8;
      return;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      y = ensureSpace(doc, y, 16, pageNumRef);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...SKY);
      doc.text("•", MARGIN, y);
      y = renderParagraph(doc, numbered[1], MARGIN, y, CONTENT_W - 14, { indent: 14 }, pageNumRef);
      return;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      y = ensureSpace(doc, y, 16, pageNumRef);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...SKY);
      doc.text("•", MARGIN, y);
      y = renderParagraph(doc, trimmed.slice(2), MARGIN, y, CONTENT_W - 14, { indent: 14 }, pageNumRef);
      return;
    }

    y = ensureSpace(doc, y, 16, pageNumRef);
    y = renderParagraph(doc, trimmed, MARGIN, y, CONTENT_W, {}, pageNumRef);
  });

  return y;
}

function buildPdf({ report, level1Labels, level2Labels, quality, ph, tds, ec, dangerFlags, status }) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageNumRef = { n: 1 };
  const qColor = QUALITY_RGB[quality] || SKY;

  doc.setFillColor(...SKY);
  doc.rect(0, 0, PAGE_W, 92, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  doc.text("Water Quality Report", MARGIN, 44);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(224, 242, 254);
  const dateStr = new Date().toLocaleString();
  doc.text(`AquaCheck · Generated ${dateStr}`, MARGIN, 62);

  const badgeText = quality.toUpperCase();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  const badgeTextW = doc.getTextWidth(badgeText);
  const badgeW = badgeTextW + 28;
  const badgeH = 26;
  const badgeX = PAGE_W - MARGIN - badgeW;
  const badgeY = 33;
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 13, 13, "F");
  doc.setTextColor(...qColor);
  doc.text(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2 + 4, { align: "center" });

  addFooter(doc, 1);

  let y = 118;

  // ── Status banner ────────────────────────────────────────────
  const statusColor = status.safe ? GREEN : RED;
  const statusBg = status.safe ? [236, 253, 245] : [254, 242, 242];
  const statusBorder = status.safe ? [187, 247, 208] : [254, 202, 202];
  const statusH = 34;
  doc.setFillColor(...statusBg);
  doc.setDrawColor(...statusBorder);
  doc.roundedRect(MARGIN, y, CONTENT_W, statusH, 6, 6, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...statusColor);
  doc.text(
    status.safe ? "✓ WATER STATUS: SAFE" : "⚠ WATER STATUS: NOT SAFE — TREATMENT REQUIRED",
    MARGIN + 14,
    y + statusH / 2 + 4
  );
  y += statusH + 16;

  // ── Summary cards: Level 1 / Level 2 ────────────────────────────
  const cardW = (CONTENT_W - 12) / 2;
  const cardH = 60;
  const l1Text = level1Labels.length && level1Labels[0] !== "No Contamination" ? level1Labels.join(", ") : "No Contamination";
  const l2Text = level2Labels.length && level2Labels[0] !== "No microscopic aquatic organisms" ? level2Labels.join(", ") : "None detected";

  doc.setFillColor(...SLATE_LIGHT_BG);
  doc.setDrawColor(...SLATE_BORDER);
  doc.roundedRect(MARGIN, y, cardW, cardH, 6, 6, "FD");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...SLATE_MUTED);
  doc.text("LEVEL 1 — SURFACE CONTAMINATION", MARGIN + 12, y + 18);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10.5);
  doc.setTextColor(...SKY);
  doc.text(l1Text, MARGIN + 12, y + 36, { maxWidth: cardW - 24 });

  const card2X = MARGIN + cardW + 12;
  doc.setFillColor(...SLATE_LIGHT_BG);
  doc.roundedRect(card2X, y, cardW, cardH, 6, 6, "FD");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...SLATE_MUTED);
  doc.text("LEVEL 2 — MICROSCOPIC ORGANISMS", card2X + 12, y + 18);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10.5);
  doc.setTextColor(...SKY);
  doc.text(l2Text, card2X + 12, y + 36, { maxWidth: cardW - 24 });

  y += cardH + 14;

  // ── Level 3 chemistry card ──────────────────────────────────────
  const chemH = 70;
  doc.setFillColor(...SLATE_LIGHT_BG);
  doc.roundedRect(MARGIN, y, CONTENT_W, chemH, 6, 6, "FD");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...SLATE_MUTED);
  doc.text("LEVEL 3 — DRINKING WATER CHEMISTRY", MARGIN + 12, y + 18);

  const stats = [
    { label: "pH", value: ph ?? "—", flagged: dangerFlags.includes("pH") },
    { label: "TDS (mg/L)", value: tds ?? "—", flagged: dangerFlags.includes("TDS") },
    { label: "EC (µS/cm)", value: ec ?? "—", flagged: dangerFlags.includes("EC") },
  ];
  const statW = (CONTENT_W - 24 - 24) / 3;
  stats.forEach((s, i) => {
    const sx = MARGIN + 12 + i * (statW + 12);
    const sy = y + 30;
    doc.setDrawColor(...(s.flagged ? RED : SLATE_BORDER));
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(sx, sy, statW, 30, 5, 5, "FD");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...SLATE_MUTED);
    doc.text(s.label, sx + statW / 2, sy + 11, { align: "center" });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...(s.flagged ? RED : SLATE_DARK));
    doc.text(String(s.value), sx + statW / 2, sy + 24, { align: "center" });
  });

  if (dangerFlags.length > 0) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...RED);
    doc.text(`⚠ Flagged: ${dangerFlags.join(", ")}`, PAGE_W - MARGIN - 12, y + 18, { align: "right" });
  }

  y += chemH + 20;

  // ── Divider before report body ──────────────────────────────────
  doc.setDrawColor(...SLATE_BORDER);
  doc.setLineWidth(1);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 22;

  // ── Report body (from backend markdown) ─────────────────────────
  renderMarkdownToPdf(doc, report, y, pageNumRef);

  return doc;
}

// ---------------------------------------------------------------------------

export default function WaterQualityReport({ level1Output, level2Output, level3Data, onBack }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [report, setReport] = useState(null);

  const level1Labels = Array.isArray(level1Output) && level1Output.length ? level1Output : [NO_CONTAM];
  const level2Labels = Array.isArray(level2Output) && level2Output.length ? level2Output : [NO_ORGANISM];

  const quality = level3Data?.quality || "Excellent";
  const ph = level3Data?.pH ?? null;
  const tds = level3Data?.TDS ?? null;
  const ec = level3Data?.EC ?? null;
  const dangerFlags = level3Data?.danger_flags || [];

  const dosages = useMemo(() => extractDosages(report), [report]);
  const status = useMemo(
    () => determineStatus(report, { level1Labels, level2Labels, quality, dangerFlags }),
    [report, level1Labels, level2Labels, quality, dangerFlags]
  );

  const generateReport = async () => {
    setIsLoading(true);
    setError(null);
    setReport(null);

    const body = {
      level1_output: level1Labels.join(", "),
      level2_output: level2Labels.join(", "),
      level3_output: {
        quality,
        pH: ph,
        TDS: tds,
        EC: ec,
        danger_flags: dangerFlags,
      },
    };

    try {
      const res = await fetch(`${API_BASE}/api/generate-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Report generation failed");
      setReport(data.report_markdown);
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  };

  const downloadReport = () => {
    if (!report) return;
    const doc = buildPdf({
      report,
      level1Labels,
      level2Labels,
      quality,
      ph,
      tds,
      ec,
      dangerFlags,
      status,
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    doc.save(`water-quality-report-${stamp}.pdf`);
  };

  return (
    <div className="min-h-screen font-sans bg-white text-slate-800">
      <div className="max-w-6xl px-6 py-8 mx-auto">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl text-sky-700">
              <Droplets className="inline-block w-8 h-8 mb-1 mr-2 -mt-1" />
              Step 4 — Water Quality Report
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Built from your Level 1, 2 &amp; 3 scan results — review, generate, and download.
            </p>
          </div>
          <button
            onClick={onBack}
            className="px-4 py-2 text-sm font-semibold bg-white border rounded-lg border-slate-200 text-slate-600 hover:border-slate-300"
          >
            ← Back
          </button>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(300px,380px)_1fr] items-start">
          {/* ── Summary column ───────────────────────────────────────── */}
          <div className="space-y-5">
            <div className="p-5 bg-white border shadow-sm rounded-xl border-slate-200">
              <h2 className="mb-3 text-xs font-semibold tracking-widest uppercase text-slate-500">
                <Waves className="inline-block w-3.5 h-3.5 mb-0.5 mr-1.5" />
                Level 1 — Surface Contamination
              </h2>
              <LabelChips labels={level1Labels} emptyText="No Contamination" />
            </div>

            <div className="p-5 bg-white border shadow-sm rounded-xl border-slate-200">
              <h2 className="mb-3 text-xs font-semibold tracking-widest uppercase text-slate-500">
                <Microscope className="inline-block w-3.5 h-3.5 mb-0.5 mr-1.5" />
                Level 2 — Microscopic Organisms
              </h2>
              <LabelChips labels={level2Labels} emptyText="None detected" />
            </div>

            <div className="p-5 bg-white border shadow-sm rounded-xl border-slate-200">
              <h2 className="mb-3 text-xs font-semibold tracking-widest uppercase text-slate-500">
                <FlaskConical className="inline-block w-3.5 h-3.5 mb-0.5 mr-1.5" />
                Level 3 — Drinking Water Chemistry
              </h2>
              <div className="flex items-center gap-2 mb-2">
                <span className={`inline-block rounded-full border px-3 py-1 text-xs font-bold ${QUALITY_STYLES[quality]}`}>
                  {quality}
                </span>
                {dangerFlags.length > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-600">
                    <AlertTriangle className="w-3 h-3" />
                    {dangerFlags.join(", ")} flagged
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2 mt-3">
                <div className="rounded-lg bg-slate-50 border border-slate-200 px-2.5 py-2 text-center">
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">pH</div>
                  <div className="text-sm font-bold text-slate-700">{ph ?? "—"}</div>
                </div>
                <div className="rounded-lg bg-slate-50 border border-slate-200 px-2.5 py-2 text-center">
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">TDS</div>
                  <div className="text-sm font-bold text-slate-700">{tds ?? "—"}</div>
                </div>
                <div className="rounded-lg bg-slate-50 border border-slate-200 px-2.5 py-2 text-center">
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">EC</div>
                  <div className="text-sm font-bold text-slate-700">{ec ?? "—"}</div>
                </div>
              </div>
              {!level3Data && (
                <p className="mt-2 text-[11px] text-amber-600">Water chemistry step not completed yet.</p>
              )}
            </div>

            <button
              onClick={generateReport}
              disabled={isLoading}
              className={`flex w-full items-center justify-center gap-2 rounded-lg py-3 text-sm font-bold tracking-wide transition-colors ${
                isLoading
                  ? "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400"
                  : "border border-sky-700 bg-sky-700 text-white hover:bg-sky-800"
              }`}
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating report…
                </>
              ) : (
                <>
                  <FileText className="w-4 h-4" />
                  {report ? "Regenerate Report" : "Generate Report"}
                </>
              )}
            </button>

            {report && !isLoading && (
              <button
                onClick={downloadReport}
                className="flex items-center justify-center w-full gap-2 py-3 text-sm font-bold tracking-wide bg-white border rounded-lg border-slate-200 text-slate-700 hover:border-slate-300"
              >
                <Download className="w-4 h-4" />
                Download Report (PDF)
              </button>
            )}

            {error && (
              <div className="px-3 py-2 text-xs text-red-700 border border-red-200 rounded-lg bg-red-50">
                <AlertTriangle className="inline-block w-3.5 h-3.5 mb-0.5 mr-1" />
                {error}
              </div>
            )}
          </div>

          {/* ── Report column ───────────────────────────────────────── */}
          <div className="space-y-5">
            {!report && !isLoading && (
              <div className="flex min-h-[420px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-center shadow-sm">
                <FileText className="w-12 h-12 mb-3 opacity-30 text-slate-400" />
                <p className="text-sm text-slate-400">
                  Review the summary on the left, then click
                  <br />
                  <strong className="text-slate-500">Generate Report</strong> to see the analysis
                </p>
              </div>
            )}

            {isLoading && (
              <div className="flex min-h-[420px] flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <span className="border-4 rounded-full h-9 w-9 animate-spin border-slate-200 border-t-sky-700" />
                <p className="mt-4 text-sm text-slate-500">Running the multi-agent pipeline…</p>
                <p className="mt-1 text-xs text-slate-400">Explaining causes, drafting purification steps, compiling report</p>
              </div>
            )}

            {report && !isLoading && (
              <>
                {/* ── Status banner — top of report ─────────────────── */}
                <StatusBanner
                  status={status}
                  level1Labels={level1Labels}
                  level2Labels={level2Labels}
                  dangerFlags={dangerFlags}
                />

                <div className="bg-white border shadow-sm rounded-xl border-slate-200">
                  <div className="border-b border-slate-100 px-5 py-3.5">
                    <h2 className="text-xs font-semibold tracking-widest uppercase text-slate-500">Generated Report</h2>
                  </div>
                  <div className="px-5 py-4">
                    <MarkdownReport markdown={report} />
                  </div>
                </div>

                {/* ── Chemical dosage calculator ──────────────────────── */}
                {dosages.length > 0 && <DosageCalculator dosages={dosages} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}