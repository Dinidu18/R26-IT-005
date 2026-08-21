// src/pages/AquaticOrganismsDetector.jsx
//
// React + Tailwind CSS frontend for the Microscopic Aquatic Organisms
// detector backend (app.py). Talks to:
//   POST {API_BASE}/api/predict   (multipart/form-data, field name "image")
//
// Expected JSON response shape (see app.py `run_inference` + `api_predict`):
//   {
//     image_size: [w, h],
//     detections: [{ class_id, class_name, confidence, bbox_xyxy: [x1,y1,x2,y2] }, ...],
//     num_detections: number,
//     mahalanobis_dist: number,
//     ood_threshold: number,
//     is_ood: boolean,
//     ood_status: "IN-DISTRIBUTION" | "OUT-OF-DISTRIBUTION",
//     ood_enabled: boolean,
//     annotated_image_base64: string (PNG, no data: prefix)
//   }
//
// Palette carried over from the provided samples: sky-700 (#0369a1) as the
// primary/brand color, slate for neutral text/borders, emerald for
// safe/in-distribution states, red for unsafe/OOD states, amber for warnings.

import { useState, useRef, useCallback } from "react";

const API_BASE = import.meta.env?.VITE_API_BASE || "http://localhost:5002";

export default function AquaticOrganismsDetector() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const fileInputRef = useRef(null);

  const handleFile = useCallback((file) => {
    if (!file) return;
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setError(null);
    setResult(null);
  }, []);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files?.length) handleFile(e.dataTransfer.files[0]);
    },
    [handleFile]
  );

  const onFileInputChange = (e) => {
    if (e.target.files?.length) handleFile(e.target.files[0]);
  };

  const clearFile = () => {
    setSelectedFile(null);
    setPreviewUrl(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const runDetection = async () => {
    if (!selectedFile) return;
    setIsLoading(true);
    setError(null);

    const formData = new FormData();
    formData.append("image", selectedFile);

    try {
      const res = await fetch(`${API_BASE}/api/predict`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Prediction failed");
      setResult(data);
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
            🔬 Aquatic Organisms Detector
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Upload a microscope image to detect contamination-relevant
            organisms
            {result?.ood_enabled ? " and run a Mahalanobis OOD check" : ""}.
          </p>
        </div>

        {/* Two-column responsive grid */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(280px,400px)_1fr] items-start">
          {/* ── Upload column ───────────────────────────────────────── */}
          <div>
            <div className="p-5 bg-white border shadow-sm rounded-xl border-slate-200">
              <h2 className="mb-4 text-xs font-semibold tracking-widest uppercase text-slate-500">
                Upload Image
              </h2>

              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
                className={`cursor-pointer rounded-lg border-2 border-dashed px-5 py-9 text-center transition-colors ${
                  isDragging
                    ? "border-sky-600 bg-sky-50"
                    : "border-slate-300 bg-slate-50 hover:border-sky-400"
                }`}
              >
                <div className="mb-2 text-3xl">🔬</div>
                <p className="mb-1 text-sm font-semibold text-slate-800">
                  Click to choose an image
                </p>
                <p className="text-xs text-slate-500">or drag &amp; drop it here</p>
                <p className="mt-2 text-[11px] text-slate-400">
                  JPG, PNG, BMP, WEBP — up to 16 MB
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onFileInputChange}
                />
              </div>

              {previewUrl && (
                <div className="relative mt-4">
                  <img
                    src={previewUrl}
                    alt="preview"
                    className="block object-cover w-full border rounded-lg max-h-80 border-slate-200"
                  />
                  <button
                    onClick={clearFile}
                    aria-label="Remove image"
                    className="absolute flex items-center justify-center text-sm text-white rounded-full right-2 top-2 h-7 w-7 bg-slate-900/65 hover:bg-slate-900/80"
                  >
                    ✕
                  </button>
                </div>
              )}

              <button
                onClick={runDetection}
                disabled={!selectedFile || isLoading}
                className={`mt-4 flex w-full items-center justify-center gap-2 rounded-lg py-3 text-sm font-bold tracking-wide transition-colors ${
                  isLoading || !selectedFile
                    ? "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400"
                    : "border border-sky-700 bg-sky-700 text-white hover:bg-sky-800"
                }`}
              >
                {isLoading ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    Running…
                  </>
                ) : (
                  "🔍 Run Detection"
                )}
              </button>

              {error && (
                <div className="px-3 py-2 mt-3 text-xs text-red-700 border border-red-200 rounded-lg bg-red-50">
                  ⚠ {error}
                </div>
              )}
            </div>
          </div>

          {/* ── Results column ──────────────────────────────────────── */}
          <div>
            {!result && !isLoading && (
              <div className="flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-center shadow-sm">
                <div className="mb-3 text-5xl opacity-35">🦠</div>
                <p className="text-sm text-slate-400">
                  Upload an image and click
                  <br />
                  <strong className="text-slate-500">Run Detection</strong> to
                  see results
                </p>
              </div>
            )}

            {isLoading && (
              <div className="flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <span className="border-4 rounded-full h-9 w-9 animate-spin border-slate-200 border-t-sky-700" />
                <p className="mt-4 text-sm text-slate-500">
                  Running inference…
                </p>
              </div>
            )}

            {result && !isLoading && (
              <div className="p-5 bg-white border shadow-sm rounded-xl border-slate-200">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                  <h2 className="text-xs font-semibold tracking-widest uppercase text-slate-500">
                    Result
                  </h2>
                  <span className="text-sm text-slate-500">
                    {result.num_detections} detection
                    {result.num_detections === 1 ? "" : "s"}
                  </span>
                </div>

                <div className="mb-3">
                  {result.ood_enabled ? (
                    <span
                      className={`inline-block rounded-full border px-3 py-1 text-xs font-bold ${
                        result.is_ood
                          ? "border-red-200 bg-red-50 text-red-600"
                          : "border-emerald-200 bg-emerald-50 text-emerald-600"
                      }`}
                    >
                      {result.is_ood ? "OUT-OF-DISTRIBUTION" : "IN-DISTRIBUTION"}
                      {" · "}
                      Mahalanobis={result.mahalanobis_dist} (threshold=
                      {result.ood_threshold})
                    </span>
                  ) : (
                    <span className="inline-block px-3 py-1 text-xs font-semibold border rounded-full border-slate-200 bg-slate-100 text-slate-500">
                      OOD detection not configured
                    </span>
                  )}
                </div>

                <img
                  src={`data:image/png;base64,${result.annotated_image_base64}`}
                  alt="annotated result"
                  className="block w-full border rounded-lg border-slate-200"
                />

                {result.detections.length > 0 ? (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="text-left">
                          {["#", "Class", "Confidence", "BBox (x1, y1, x2, y2)"].map(
                            (h) => (
                              <th
                                key={h}
                                className="whitespace-nowrap border-b border-slate-200 px-2.5 py-2 text-[11px] uppercase tracking-wide text-slate-500"
                              >
                                {h}
                              </th>
                            )
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {result.detections.map((d, i) => (
                          <tr key={i}>
                            <td className="border-b border-slate-100 px-2.5 py-2 text-slate-800">
                              {i + 1}
                            </td>
                            <td className="whitespace-nowrap border-b border-slate-100 px-2.5 py-2 font-semibold text-sky-700">
                              {d.class_name}
                            </td>
                            <td className="border-b border-slate-100 px-2.5 py-2 text-slate-800">
                              {d.confidence.toFixed(3)}
                            </td>
                            <td className="whitespace-nowrap border-b border-slate-100 px-2.5 py-2 text-slate-400">
                              {d.bbox_xyxy.map((v) => v.toFixed(1)).join(", ")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-4 mb-0 text-sm text-slate-500">
                    No organisms detected in this image.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}