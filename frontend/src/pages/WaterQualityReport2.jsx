// src/pages/WaterQualityReport.jsx
//
// React + Tailwind CSS frontend for the Water Quality Multi-Agent Report
// backend (app.py). Talks to:
//   POST {API_BASE}/api/generate-report   (application/json)
//
// Request body:
//   {
//     level1_output: string,        // e.g. "No Contamination" | "Oil Pollution" | ...
//     level2_output: string,        // e.g. "No microscopic aquatic organisms" | "Raphidiopsis" | ...
//     level3_output: {
//       quality: "Excellent" | "Good" | "Poor" | "Unsafe",
//       pH: number, TDS: number, EC: number,
//       danger_flags: string[]      // subset of ["pH", "TDS", "EC"]
//     }
//   }
//
// Response body:
//   { report_markdown: string }  or  { error: string }
//
// Palette matches AquaticOrganismsDetector.jsx: sky-700 (#0369a1) as the
// primary/brand color, slate for neutral text/borders, emerald for
// safe/excellent states, red for unsafe states, amber for warnings.

import { useState } from "react";
import {
  Droplets,
  FlaskConical,
  Microscope,
  Waves,
  Loader2,
  AlertTriangle,
  FileText,
  ChevronDown,
} from "lucide-react";

const API_BASE =
  import.meta.env?.VITE_REPORT_API_BASE || "http://localhost:5003";

const LEVEL1_OPTIONS = [
  "No Contamination",
  "Acid Pollution",
  "Dead Animals Pollution",
  "Oil Pollution",
  "Plastic Pollution",
];

const LEVEL2_OPTIONS = [
  "No microscopic aquatic organisms",
  "Anabaenopsis",
  "Ceratium",
  "Coelosphaerium",
  "Euglena",
  "Gomphosphaeria",
  "Merismopedia",
  "Microcystis",
  "Oscillatoria",
  "Phormidium",
  "Raphidiopsis",
];

const QUALITY_OPTIONS = ["Excellent", "Good", "Poor", "Unsafe"];

const QUALITY_STYLES = {
  Excellent: "border-emerald-200 bg-emerald-50 text-emerald-600",
  Good: "border-emerald-200 bg-emerald-50 text-emerald-600",
  Poor: "border-amber-200 bg-amber-50 text-amber-600",
  Unsafe: "border-red-200 bg-red-50 text-red-600",
};

// ---------------------------------------------------------------------------
// Minimal markdown -> JSX renderer, tuned to the ReportCompilerAgent's
// fixed structure (# title, ## headers, numbered/bulleted lists, **bold**).
// ---------------------------------------------------------------------------
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
  let listType = null; // "ul" | "ol"

  const flushList = (key) => {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];
    const Tag = listType === "ol" ? "ol" : "ul";
    blocks.push(
      <Tag
        key={`list-${key}`}
        className={`my-2.5 space-y-1.5 pl-5 text-sm text-slate-700 ${
          listType === "ol" ? "list-decimal" : "list-disc"
        }`}
      >
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
        <h1
          key={idx}
          className="mb-3 text-xl font-bold tracking-tight text-sky-700"
        >
          {trimmed.slice(2)}
        </h1>
      );
      return;
    }
    if (trimmed.startsWith("## ")) {
      flushList(idx);
      blocks.push(
        <h2
          key={idx}
          className="mb-2 mt-6 border-b border-slate-200 pb-1.5 text-sm font-bold uppercase tracking-wide text-slate-700 first:mt-0"
        >
          {trimmed.slice(3)}
        </h2>
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
      <p key={idx} className="my-2 text-sm leading-relaxed text-slate-700">
        {inlineFormat(trimmed, `p-${idx}`)}
      </p>
    );
  });
  flushList("end");

  return <div>{blocks}</div>;
}

// ---------------------------------------------------------------------------

export default function WaterQualityReport() {
  const [level1, setLevel1] = useState("No Contamination");
  const [level2, setLevel2] = useState("No microscopic aquatic organisms");
  const [quality, setQuality] = useState("Excellent");
  const [ph, setPh] = useState("7");
  const [tds, setTds] = useState("300");
  const [ec, setEc] = useState("400");
  const [dangerFlags, setDangerFlags] = useState([]);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [report, setReport] = useState(null);

  const toggleFlag = (flag) => {
    setDangerFlags((prev) =>
      prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag]
    );
  };

  const generateReport = async () => {
    setIsLoading(true);
    setError(null);
    setReport(null);

    const body = {
      level1_output: level1,
      level2_output: level2,
      level3_output: {
        quality,
        pH: ph === "" ? null : Number(ph),
        TDS: tds === "" ? null : Number(tds),
        EC: ec === "" ? null : Number(ec),
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

  return (
    <div className="min-h-screen font-sans bg-slate-50 text-slate-800">
      <div className="max-w-6xl px-6 py-8 mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl text-sky-700">
            <Droplets className="inline-block w-8 h-8 mb-1 mr-2 -mt-1" />
            Water Quality Confirmation Report
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Feed in your Level 1 / 2 / 3 model outputs to generate a grounded,
            multi-agent purification &amp; safety report.
          </p>
        </div>

        {/* Two-column responsive grid */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(300px,420px)_1fr] items-start">
          {/* ── Input column ────────────────────────────────────────── */}
          <div className="space-y-5">
            {/* Level 1 + 2 */}
            <div className="p-5 bg-white border shadow-sm rounded-xl border-slate-200">
              <h2 className="mb-4 text-xs font-semibold tracking-widest uppercase text-slate-500">
                <Waves className="inline-block w-3.5 h-3.5 mb-0.5 mr-1.5" />
                Level 1 &amp; 2 — Contamination Detectors
              </h2>

              <label className="block mb-1.5 text-xs font-semibold text-slate-600">
                Surface contamination (Level 1)
              </label>
              <div className="relative mb-4">
                <select
                  value={level1}
                  onChange={(e) => setLevel1(e.target.value)}
                  className="w-full appearance-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                >
                  {LEVEL1_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute w-4 h-4 -translate-y-1/2 pointer-events-none right-3 top-1/2 text-slate-400" />
              </div>

              <label className="block mb-1.5 text-xs font-semibold text-slate-600">
                <Microscope className="inline-block w-3.5 h-3.5 mb-0.5 mr-1" />
                Microscopic organism (Level 2)
              </label>
              <div className="relative">
                <select
                  value={level2}
                  onChange={(e) => setLevel2(e.target.value)}
                  className="w-full appearance-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                >
                  {LEVEL2_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute w-4 h-4 -translate-y-1/2 pointer-events-none right-3 top-1/2 text-slate-400" />
              </div>
            </div>

            {/* Level 3 */}
            <div className="p-5 bg-white border shadow-sm rounded-xl border-slate-200">
              <h2 className="mb-4 text-xs font-semibold tracking-widest uppercase text-slate-500">
                <FlaskConical className="inline-block w-3.5 h-3.5 mb-0.5 mr-1.5" />
                Level 3 — Drinking Water Chemistry
              </h2>

              <label className="block mb-1.5 text-xs font-semibold text-slate-600">
                Overall quality label
              </label>
              <div className="relative mb-4">
                <select
                  value={quality}
                  onChange={(e) => setQuality(e.target.value)}
                  className="w-full appearance-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                >
                  {QUALITY_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute w-4 h-4 -translate-y-1/2 pointer-events-none right-3 top-1/2 text-slate-400" />
              </div>

              <div className="grid grid-cols-3 gap-3 mb-4">
                <div>
                  <label className="block mb-1.5 text-xs font-semibold text-slate-600">
                    pH
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={ph}
                    onChange={(e) => setPh(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                  />
                </div>
                <div>
                  <label className="block mb-1.5 text-xs font-semibold text-slate-600">
                    TDS (mg/L)
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={tds}
                    onChange={(e) => setTds(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                  />
                </div>
                <div>
                  <label className="block mb-1.5 text-xs font-semibold text-slate-600">
                    EC (µS/cm)
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={ec}
                    onChange={(e) => setEc(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                  />
                </div>
              </div>

              <label className="block mb-1.5 text-xs font-semibold text-slate-600">
                Flag as dangerous
              </label>
              <div className="flex gap-2">
                {["pH", "TDS", "EC"].map((flag) => (
                  <button
                    key={flag}
                    type="button"
                    onClick={() => toggleFlag(flag)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      dangerFlags.includes(flag)
                        ? "border-red-200 bg-red-50 text-red-600"
                        : "border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300"
                    }`}
                  >
                    {flag}
                  </button>
                ))}
              </div>
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
                  Generate Report
                </>
              )}
            </button>

            {error && (
              <div className="px-3 py-2 text-xs text-red-700 border border-red-200 rounded-lg bg-red-50">
                <AlertTriangle className="inline-block w-3.5 h-3.5 mb-0.5 mr-1" />
                {error}
              </div>
            )}
          </div>

          {/* ── Report column ───────────────────────────────────────── */}
          <div>
            {!report && !isLoading && (
              <div className="flex min-h-[420px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-center shadow-sm">
                <FileText className="w-12 h-12 mb-3 opacity-30 text-slate-400" />
                <p className="text-sm text-slate-400">
                  Fill in the pipeline results and click
                  <br />
                  <strong className="text-slate-500">Generate Report</strong>{" "}
                  to see the analysis
                </p>
              </div>
            )}

            {isLoading && (
              <div className="flex min-h-[420px] flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <span className="border-4 rounded-full h-9 w-9 animate-spin border-slate-200 border-t-sky-700" />
                <p className="mt-4 text-sm text-slate-500">
                  Running the multi-agent pipeline…
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Explaining causes, drafting purification steps, compiling report
                </p>
              </div>
            )}

            {report && !isLoading && (
              <div className="bg-white border shadow-sm rounded-xl border-slate-200">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
                  <h2 className="text-xs font-semibold tracking-widest uppercase text-slate-500">
                    Generated Report
                  </h2>
                  <span
                    className={`inline-block rounded-full border px-3 py-1 text-xs font-bold ${QUALITY_STYLES[quality]}`}
                  >
                    {quality}
                  </span>
                </div>
                <div className="px-5 py-4">
                  <MarkdownReport markdown={report} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}