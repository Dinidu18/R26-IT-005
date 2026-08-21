// src/pages/Predict.jsx
// Step 3 of the pipeline — drinking water chemistry (Level 3 output).
import { useState, useEffect } from "react";

const LABEL_CONFIG = {
  Excellent: { color: "#0891b2", glow: "rgba(8,145,178,0.08)", icon: "✅", emoji: "🌊" },
  Good: { color: "#059669", glow: "rgba(5,150,105,0.08)", icon: "✅", emoji: "💧" },
  Poor: { color: "#d97706", glow: "rgba(217,119,6,0.08)", icon: "⚠️", emoji: "🟡" },
  Unsafe: { color: "#dc2626", glow: "rgba(220,38,38,0.08)", icon: "❌", emoji: "☠️" },
};

const FEATURE_META = {
  pH: { label: "pH Level", unit: "", min: 0, max: 14, step: 0.01, default: 7.0, hint: "Safe: 6.5 – 8.5 | Neutral = 7", color: "#7c3aed", desc: "Measures acidity or alkalinity of water. Neutral is 7; safe drinking range is 6.5–8.5.", safeMin: 6.5, safeMax: 8.5 },
  TDS: { label: "TDS", unit: "mg/L", min: 0, max: 2000, step: 1, default: 250, hint: "Safe: < 600 mg/L | Excellent: < 300", color: "#0369a1", desc: "Total Dissolved Solids — measures minerals, salts, and metals dissolved in water.", safeMax: 600 },
  EC: { label: "Electrical Conductivity", unit: "µS/cm", min: 0, max: 6250, step: 1, default: 350, hint: "Safe: < 937 µS/cm | Excellent: < 390", color: "#047857", desc: "Measures ability of water to conduct electricity — a proxy for dissolved ion concentration.", safeMax: 937 },
};

const SAMPLE_PRESETS = [
  { label: "Tap Water", icon: "🚰", pH: 7.2, TDS: 180, EC: 280 },
  { label: "Spring Water", icon: "🏔️", pH: 7.5, TDS: 80, EC: 120 },
  { label: "Borehole", icon: "⛏️", pH: 6.8, TDS: 520, EC: 820 },
  { label: "Contaminated", icon: "🏭", pH: 4.2, TDS: 1200, EC: 2400 },
  { label: "River Sample", icon: "🌿", pH: 7.8, TDS: 390, EC: 610 },
  { label: "Seawater", icon: "🌊", pH: 8.1, TDS: 1800, EC: 5200 },
];

const card = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "1.25rem",
  marginBottom: "1rem",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
};

const muted = "#64748b";
const dim = "#94a3b8";
const textPrimary = "#1e293b";

// auto-derive which fields are out of the safe range
function autoDangerFlags(values) {
  const flags = [];
  if (values.pH < FEATURE_META.pH.safeMin || values.pH > FEATURE_META.pH.safeMax) flags.push("pH");
  if (values.TDS > FEATURE_META.TDS.safeMax) flags.push("TDS");
  if (values.EC > FEATURE_META.EC.safeMax) flags.push("EC");
  return flags;
}

function FeatureGauge({ feature, value }) {
  const meta = FEATURE_META[feature];
  const norm = Math.min(1, Math.max(0, (value - meta.min) / (meta.max - meta.min)));
  const pct = norm * 100;
  const hue = Math.round(120 - norm * 120);
  const gaugeColor = `hsl(${hue}, 75%, 45%)`;
  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
        <span style={{ color: muted, fontSize: "0.72rem", letterSpacing: "0.07em", textTransform: "uppercase" }}>{meta.label}</span>
        <span style={{ color: meta.color, fontWeight: 700, fontSize: "0.85rem" }}>
          {value.toFixed(feature === "pH" ? 2 : 0)}
          {meta.unit && ` ${meta.unit}`}
        </span>
      </div>
      <div style={{ height: "7px", background: "#e2e8f0", borderRadius: "4px", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, borderRadius: "4px", background: `linear-gradient(90deg, #10b981, ${gaugeColor})`, transition: "width 0.5s ease" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "3px", fontSize: "0.62rem", color: dim }}>
        <span>{meta.min}{meta.unit}</span>
        <span style={{ color: muted, fontSize: "0.65rem" }}>{meta.hint}</span>
        <span>{meta.max}{meta.unit}</span>
      </div>
    </div>
  );
}

function ShapBar({ feature, shap, maxAbs }) {
  const isPos = shap >= 0;
  const width = (Math.abs(shap) / maxAbs) * 100;
  const color = isPos ? "#059669" : "#dc2626";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
      <span style={{ width: "56px", fontSize: "0.72rem", color: muted, textAlign: "right", flexShrink: 0 }}>{feature}</span>
      <div style={{ flex: 1, height: "24px", display: "flex", alignItems: "center", position: "relative" }}>
        <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: "1px", background: "#cbd5e1" }} />
        {isPos ? (
          <div style={{ position: "absolute", left: "50%", width: `${width / 2}%`, height: "100%", background: color, borderRadius: "0 4px 4px 0" }} />
        ) : (
          <div style={{ position: "absolute", right: "50%", width: `${width / 2}%`, height: "100%", background: color, borderRadius: "4px 0 0 4px" }} />
        )}
      </div>
      <span style={{ width: "72px", fontSize: "0.72rem", fontWeight: 700, color, textAlign: "left", flexShrink: 0 }}>
        {isPos ? "+" : ""}
        {(shap * 100).toFixed(1)}%
      </span>
    </div>
  );
}

function ProbBar({ label, prob, isActive }) {
  const cfg = LABEL_CONFIG[label];
  return (
    <div style={{ marginBottom: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
        <span style={{ fontSize: "0.78rem", color: isActive ? cfg.color : muted, fontWeight: isActive ? 700 : 400 }}>
          {label} {isActive && "◀"}
        </span>
        <span style={{ fontSize: "0.78rem", fontWeight: 700, color: cfg.color }}>{prob.toFixed(1)}%</span>
      </div>
      <div style={{ height: "7px", background: "#e2e8f0", borderRadius: "4px", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${prob}%`, borderRadius: "4px", background: cfg.color, opacity: isActive ? 1 : 0.4, transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}

export default function WaterQualityPredict({ onNext, onBack, initialValues, initialRaw, initialFlags }) {
  const [values, setValues] = useState(initialValues || { pH: 7.0, TDS: 250, EC: 350 });
  const [result, setResult] = useState(initialRaw || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dangerFlags, setDangerFlags] = useState(initialFlags || autoDangerFlags(values));

  useEffect(() => {
    if (result) setDangerFlags(autoDangerFlags(values));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const handleChange = (feat, val) => {
    const meta = FEATURE_META[feat];
    const clamped = Math.min(meta.max, Math.max(meta.min, Number(val)));
    setValues((prev) => ({ ...prev, [feat]: clamped }));
  };

  const toggleFlag = (flag) => {
    setDangerFlags((prev) => (prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag]));
  };

  const predict = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("http://localhost:5001/api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResult(data);
      setDangerFlags(autoDangerFlags(values));
    } catch (e) {
      setError(e.message);
      const demo = buildDemoResult(values);
      setResult(demo);
      setDangerFlags(autoDangerFlags(values));
    } finally {
      setLoading(false);
    }
  };

  const loadPreset = (preset) => {
    setValues({ pH: preset.pH, TDS: preset.TDS, EC: preset.EC });
    setResult(null);
  };

  const continueToReport = () => {
    onNext?.({
      quality: result.label,
      pH: values.pH,
      TDS: values.TDS,
      EC: values.EC,
      danger_flags: dangerFlags,
      raw: result,
    });
  };

  const maxAbs = result ? Math.max(...result.shap_vals.map(Math.abs)) : 1;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", color: textPrimary, maxWidth: "1200px", margin: "0 auto", boxSizing: "border-box", padding: "1.5rem", minHeight: "100vh" }}>
      <div style={{ marginBottom: "1.5rem", display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: "1rem" }}>
        <div>
          <h1 style={{ fontSize: "2.4rem", fontWeight: 700, color: "#0369a1", letterSpacing: "-0.02em", marginBottom: "0.3rem", marginTop: 0 }}>
            💧 Step 3 — Drinking Water Chemistry
          </h1>
          <p style={{ color: muted, fontSize: "0.82rem", margin: 0 }}>
            Enter water parameters → Random Forest classification with SHAP explainability
          </p>
        </div>
        <button
          onClick={onBack}
          style={{ border: "1px solid #e2e8f0", background: "#fff", color: muted, borderRadius: "8px", padding: "0.6rem 1.1rem", fontSize: "0.85rem", fontWeight: 600, cursor: "pointer", height: "fit-content" }}
        >
          ← Back
        </button>
      </div>

      <div style={{ marginBottom: "1.25rem" }}>
        <p style={{ fontSize: "0.68rem", color: dim, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "0.5rem", marginTop: 0 }}>
          Quick presets
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
          {SAMPLE_PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => loadPreset(p)}
              style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: muted, borderRadius: "8px", padding: "0.35rem 0.7rem", fontSize: "0.73rem", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.35rem" }}
            >
              {p.icon} {p.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "1.25rem" }}>
        <div>
          <div style={card}>
            <h2 style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.12em", color: muted, marginBottom: "1.25rem", marginTop: 0 }}>
              Input Parameters
            </h2>

            {Object.entries(FEATURE_META).map(([feat, meta]) => (
              <div key={feat} style={{ marginBottom: "1.5rem" }}>
                <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "0.9rem", border: "1px solid #e2e8f0" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.6rem" }}>
                    <div>
                      <span style={{ fontSize: "0.82rem", fontWeight: 600, color: meta.color }}>{meta.label}</span>
                      {meta.unit && <span style={{ fontSize: "0.68rem", color: dim, marginLeft: "0.35rem" }}>({meta.unit})</span>}
                    </div>
                    <input
                      type="number"
                      min={meta.min}
                      max={meta.max}
                      step={meta.step}
                      value={values[feat]}
                      onChange={(e) => handleChange(feat, e.target.value)}
                      style={{ width: "82px", textAlign: "center", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "0.3rem 0.4rem", fontSize: "0.82rem", background: "#fff", color: textPrimary, outline: "none" }}
                    />
                  </div>
                  <input
                    type="range"
                    min={meta.min}
                    max={meta.max}
                    step={meta.step}
                    value={values[feat]}
                    onChange={(e) => handleChange(feat, e.target.value)}
                    style={{ width: "100%", accentColor: meta.color, cursor: "pointer" }}
                  />
                  <p style={{ fontSize: "0.67rem", color: dim, margin: "0.35rem 0 0" }}>{meta.desc}</p>
                  <p style={{ fontSize: "0.68rem", color: muted, margin: "0.2rem 0 0", fontStyle: "italic" }}>💡 {meta.hint}</p>
                </div>
              </div>
            ))}

            <button
              onClick={predict}
              disabled={loading}
              style={{ width: "100%", padding: "0.8rem", background: loading ? "#f1f5f9" : "#0369a1", border: `1px solid ${loading ? "#e2e8f0" : "#0369a1"}`, color: loading ? muted : "#fff", borderRadius: "8px", fontSize: "0.88rem", fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", letterSpacing: "0.03em", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}
            >
              {loading ? "Analyzing…" : "⚡ Analyze Water Quality"}
            </button>

            {error && (
              <div style={{ marginTop: "0.7rem", padding: "0.6rem 0.9rem", background: "#fef9c3", border: "1px solid #fde047", borderRadius: "8px", fontSize: "0.73rem", color: "#92400e" }}>
                ⚠ API offline — showing demo prediction
              </div>
            )}
          </div>

          <div style={card}>
            <h2 style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.12em", color: muted, marginBottom: "1rem", marginTop: 0 }}>
              Live Gauge
            </h2>
            {Object.keys(FEATURE_META).map((feat) => (
              <FeatureGauge key={feat} feature={feat} value={values[feat]} />
            ))}
          </div>
        </div>

        <div>
          {!result && !loading && (
            <div style={{ ...card, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "420px", borderStyle: "dashed", borderColor: "#cbd5e1", background: "#f8fafc" }}>
              <div style={{ fontSize: "3.5rem", marginBottom: "1rem", opacity: 0.35 }}>💧</div>
              <p style={{ color: dim, fontSize: "0.82rem", textAlign: "center", margin: 0 }}>
                Set parameters and click
                <br />
                <strong style={{ color: muted }}>Analyze Water Quality</strong>
              </p>
            </div>
          )}

          {loading && (
            <div style={{ ...card, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "420px" }}>
              <div style={{ width: "36px", height: "36px", border: "3px solid #e2e8f0", borderTopColor: "#0369a1", borderRadius: "50%", animation: "spin 0.8s linear infinite", marginBottom: "1rem" }} />
              <p style={{ color: muted, fontSize: "0.82rem" }}>Running model + SHAP explainer…</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {result &&
            !loading &&
            (() => {
              const cfg = LABEL_CONFIG[result.label];
              return (
                <div>
                  <div style={{ ...card, background: cfg.glow, border: `1px solid ${cfg.color}30` }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
                      <div>
                        <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.12em", color: muted, marginBottom: "0.4rem" }}>
                          Quality Classification
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
                          <span style={{ fontSize: "2.2rem" }}>{cfg.emoji}</span>
                          <div>
                            <div style={{ fontSize: "1.8rem", fontWeight: 700, color: cfg.color, lineHeight: 1 }}>{result.label}</div>
                            <div style={{ fontSize: "0.78rem", color: muted, marginTop: "0.2rem" }}>
                              {result.is_safe ? "✅ Safe to drink" : "❌ Not safe to drink"}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: "2.2rem", fontWeight: 700, color: cfg.color, lineHeight: 1 }}>{result.confidence.toFixed(1)}%</div>
                        <div style={{ fontSize: "0.68rem", color: muted }}>confidence</div>
                        {result.demo_mode && <div style={{ fontSize: "0.63rem", color: "#d97706", marginTop: "0.3rem" }}>demo mode</div>}
                      </div>
                    </div>
                  </div>

                  <div style={card}>
                    <h3 style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em", color: muted, marginBottom: "1rem", marginTop: 0 }}>
                      Class Probabilities
                    </h3>
                    {["Excellent", "Good", "Poor", "Unsafe"].map((lbl) => (
                      <ProbBar key={lbl} label={lbl} prob={result.probs[lbl]} isActive={result.label === lbl} />
                    ))}
                  </div>

                  <div style={card}>
                    <h3 style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em", color: muted, marginBottom: "4px", marginTop: 0 }}>
                      SHAP Feature Influence
                    </h3>
                    <p style={{ fontSize: "0.68rem", color: dim, marginBottom: "0.9rem", marginTop: 0 }}>
                      How each feature pushed the prediction toward "{result.label}"
                    </p>
                    {result.plain_reasons.map((r, i) => (
                      <ShapBar key={i} feature={r.feature} shap={r.shap} maxAbs={maxAbs} />
                    ))}
                  </div>

                  {/* ── Danger flags (auto-derived, overridable) ─────────── */}
                  <div style={card}>
                    <h3 style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em", color: muted, marginBottom: "0.8rem", marginTop: 0 }}>
                      Flag as dangerous
                    </h3>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      {["pH", "TDS", "EC"].map((flag) => (
                        <button
                          key={flag}
                          type="button"
                          onClick={() => toggleFlag(flag)}
                          style={{
                            borderRadius: "999px",
                            padding: "0.4rem 0.9rem",
                            fontSize: "0.75rem",
                            fontWeight: 600,
                            cursor: "pointer",
                            border: dangerFlags.includes(flag) ? "1px solid #fecaca" : "1px solid #e2e8f0",
                            background: dangerFlags.includes(flag) ? "#fef2f2" : "#f8fafc",
                            color: dangerFlags.includes(flag) ? "#dc2626" : muted,
                          }}
                        >
                          {flag}
                        </button>
                      ))}
                    </div>
                    <p style={{ fontSize: "0.68rem", color: dim, margin: "0.6rem 0 0" }}>
                      Auto-flagged from safe-range thresholds — tap to override.
                    </p>
                  </div>

                  <button
                    onClick={continueToReport}
                    style={{ width: "100%", padding: "0.9rem", background: "#0369a1", border: "1px solid #0369a1", color: "#fff", borderRadius: "8px", fontSize: "0.9rem", fontWeight: 700, cursor: "pointer", letterSpacing: "0.03em" }}
                  >
                    Continue to Report →
                  </button>
                </div>
              );
            })()}
        </div>
      </div>
    </div>
  );
}

function buildDemoResult(values) {
  const { pH, TDS, EC } = values;
  let score = 0;
  if (pH < 6.5 || pH > 8.5) score += 2;
  else if (pH < 6.0 || pH > 9.0) score += 1;
  if (TDS > 900) score += 3;
  else if (TDS > 600) score += 2;
  else if (TDS > 300) score += 1;
  if (EC > 3125) score += 3;
  else if (EC > 937) score += 2;
  else if (EC > 390) score += 1;
  const avg = score / 3;
  let label, probs, shapVals;
  if (avg < 0.5) {
    label = "Excellent";
    probs = { Excellent: 78, Good: 16, Poor: 4, Unsafe: 2 };
    shapVals = [0.12, -0.04, -0.03];
  } else if (avg < 1.5) {
    label = "Good";
    probs = { Excellent: 10, Good: 68, Poor: 17, Unsafe: 5 };
    shapVals = [-0.05, 0.08, 0.06];
  } else if (avg < 2.5) {
    label = "Poor";
    probs = { Excellent: 2, Good: 12, Poor: 67, Unsafe: 19 };
    shapVals = [-0.09, -0.07, 0.11];
  } else {
    label = "Unsafe";
    probs = { Excellent: 1, Good: 4, Poor: 14, Unsafe: 81 };
    shapVals = [-0.13, -0.1, -0.12];
  }
  return {
    label,
    confidence: probs[label],
    is_safe: label === "Excellent" || label === "Good",
    probs,
    shap_vals: shapVals,
    base_val: 0.25,
    plain_reasons: [
      { feature: "pH", value: pH, unit: "", shap: shapVals[0], strength: "moderately", direction: shapVals[0] > 0 ? "increases" : "decreases", level: pH >= 6.5 && pH <= 8.5 ? "optimal range" : "out of range", detail: `pH ${pH.toFixed(2)} – ${pH >= 6.5 && pH <= 8.5 ? "in optimal range" : "outside safe range"}. Safe: 6.5–8.5.`, description: "Acidity/alkalinity" },
      { feature: "TDS", value: TDS, unit: "mg/L", shap: shapVals[1], strength: "moderately", direction: shapVals[1] > 0 ? "increases" : "decreases", level: TDS < 300 ? "very low" : TDS < 600 ? "moderate" : TDS < 900 ? "elevated" : "very high", detail: `TDS of ${TDS} mg/L – ${TDS < 600 ? "within acceptable range" : "elevated mineral content"}.`, description: "Total Dissolved Solids" },
      { feature: "EC", value: EC, unit: "µS/cm", shap: shapVals[2], strength: "moderately", direction: shapVals[2] > 0 ? "increases" : "decreases", level: EC < 390 ? "very low" : EC < 937 ? "moderate" : EC < 3125 ? "elevated" : "very high", detail: `EC of ${EC} µS/cm – ${EC < 937 ? "acceptable conductivity" : "high ionic concentration"}.`, description: "Electrical Conductivity" },
    ],
    feature_stats: [
      { feature: "pH", value: pH, unit: "", min: 0, max: 14, norm: pH / 14, level: "optimal range", description: "Acidity/alkalinity" },
      { feature: "TDS", value: TDS, unit: "mg/L", min: 0, max: 2000, norm: TDS / 2000, level: "moderate", description: "Total Dissolved Solids" },
      { feature: "EC", value: EC, unit: "µS/cm", min: 0, max: 6250, norm: EC / 6250, level: "moderate", description: "Electrical Conductivity" },
    ],
    demo_mode: true,
  };
}