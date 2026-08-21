// src/pages/WaterQualityWizard.jsx
//
// Orchestrates the 4-step pipeline:
//   Step 1 -> WaterContaminationDetector.jsx  (Level 1 output — array of labels)
//   Step 2 -> AquaticOrganismsDetector.jsx    (Level 2 output — array of labels)
//   Step 3 -> WaterQualityPredict.jsx         (Level 3 output: quality + pH/TDS/EC)
//   Step 4 -> WaterQualityReport.jsx          (final report + download)
//
// Holds all collected values in state and passes them down as props so
// nothing needs to be re-entered manually in step 4.

import { useState } from "react";
import WaterContaminationDetector from "./WaterContaminationDetector";
import AquaticOrganismsDetector from "./AquaticOrganismsDetector";
import WaterQualityPredict from "./WaterQualityPredict";
import WaterQualityReport from "./WaterQualityReport";

const STEPS = [
  { id: 1, label: "Contamination Scan" },
  { id: 2, label: "Organism Scan" },
  { id: 3, label: "Water Chemistry" },
  { id: 4, label: "Report" },
];

export default function WaterQualityWizard() {
  const [step, setStep] = useState(1);
  const [pipeline, setPipeline] = useState({
    level1: null, // { output: string[], raw: apiResult }
    level2: null, // { output: string[], raw: apiResult }
    level3: null, // { quality, pH, TDS, EC, danger_flags, raw }
  });

  // highest step the user has actually completed (controls which stepper
  // circles are clickable)
  const maxReached = pipeline.level3
    ? 4
    : pipeline.level2
    ? 3
    : pipeline.level1
    ? 2
    : 1;

  const goNext = (key, data) => {
    setPipeline((prev) => ({ ...prev, [key]: data }));
    setStep((s) => Math.min(4, s + 1));
  };

  const goBack = () => setStep((s) => Math.max(1, s - 1));

  const jumpTo = (target) => {
    if (target <= maxReached) setStep(target);
  };

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        minHeight: "100vh",
        background: "#ffffff",
      }}
    >
      <Stepper current={step} maxReached={maxReached} onJump={jumpTo} />

      {step === 1 && (
        <WaterContaminationDetector
          initialRaw={pipeline.level1?.raw}
          initialOutput={pipeline.level1?.output}
          onNext={(output, raw) => goNext("level1", { output, raw })}
        />
      )}

      {step === 2 && (
        <AquaticOrganismsDetector
          initialRaw={pipeline.level2?.raw}
          initialOutput={pipeline.level2?.output}
          onBack={goBack}
          onNext={(output, raw) => goNext("level2", { output, raw })}
        />
      )}

      {step === 3 && (
        <WaterQualityPredict
          initialRaw={pipeline.level3?.raw}
          initialValues={
            pipeline.level3
              ? {
                  pH: pipeline.level3.pH,
                  TDS: pipeline.level3.TDS,
                  EC: pipeline.level3.EC,
                }
              : undefined
          }
          initialFlags={pipeline.level3?.danger_flags}
          onBack={goBack}
          onNext={(data) => goNext("level3", data)}
        />
      )}

      {step === 4 && (
        <WaterQualityReport
          level1Output={pipeline.level1?.output}
          level2Output={pipeline.level2?.output}
          level3Data={pipeline.level3}
          onBack={goBack}
        />
      )}
    </div>
  );
}

function Stepper({ current, maxReached, onJump }) {
  return (
    <div
      style={{
        maxWidth: "900px",
        margin: "0 auto",
        padding: "1.5rem 1.5rem 0",
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        {STEPS.map((s, i) => {
          const isDone = s.id < current || (s.id <= maxReached && s.id !== current);
          const isCurrent = s.id === current;
          const clickable = s.id <= maxReached;
          return (
            <div key={s.id} style={{ display: "flex", alignItems: "center", flex: i < STEPS.length - 1 ? 1 : "none" }}>
              <div
                onClick={() => clickable && onJump(s.id)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  cursor: clickable ? "pointer" : "default",
                  minWidth: "84px",
                }}
              >
                <div
                  style={{
                    width: "30px",
                    height: "30px",
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "0.78rem",
                    fontWeight: 700,
                    background: isCurrent ? "#0369a1" : isDone ? "#e0f2fe" : "#e2e8f0",
                    color: isCurrent ? "#fff" : isDone ? "#0369a1" : "#94a3b8",
                    border: isCurrent ? "2px solid #0369a1" : "2px solid transparent",
                    transition: "all 0.15s",
                  }}
                >
                  {s.id < current || (s.id <= maxReached && s.id !== current) ? "✓" : s.id}
                </div>
                <span
                  style={{
                    marginTop: "6px",
                    fontSize: "0.68rem",
                    fontWeight: isCurrent ? 700 : 500,
                    color: isCurrent ? "#0369a1" : "#64748b",
                    textAlign: "center",
                  }}
                >
                  {s.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    height: "2px",
                    background: s.id < maxReached ? "#0369a1" : "#e2e8f0",
                    margin: "0 4px 22px",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}