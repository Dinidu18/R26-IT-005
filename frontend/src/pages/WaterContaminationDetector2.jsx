// src/pages/WaterContaminationDetector.jsx
import { useState, useRef, useCallback } from "react";

const API_BASE = import.meta.env?.VITE_API_BASE || "http://localhost:5000";

const muted = "#64748b";
const dim = "#94a3b8";
const textPrimary = "#1e293b";

const card = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "1.25rem",
  marginBottom: "1rem",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
};

const sectionLabel = {
  fontSize: "0.7rem",
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  color: muted,
  marginBottom: "1rem",
  marginTop: 0,
  fontWeight: 600,
};

export default function WaterContaminationDetector() {
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
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        color: textPrimary,
        maxWidth: "1100px",
        margin: "0 auto",
        boxSizing: "border-box",
        padding: "1.5rem",
        minHeight: "100vh",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <h1
          style={{
            fontSize: "clamp(1.6rem, 4vw, 2.4rem)",
            fontWeight: 700,
            color: "#0369a1",
            letterSpacing: "-0.02em",
            marginBottom: "0.3rem",
            marginTop: 0,
          }}
        >
          🌊 Water Contamination Detector
        </h1>
        <p style={{ color: muted, fontSize: "0.85rem", margin: 0 }}>
          Upload an image to run the trained YOLOv11 model
          {result?.ood_enabled ? " + Mahalanobis OOD check" : ""}.
        </p>
      </div>

      {/* Responsive two-column grid: collapses to 1 column under 760px */}
      <div className="wcd-grid">
        {/* Upload column */}
        <div>
          <div style={card}>
            <h2 style={sectionLabel}>Upload Image</h2>

            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              style={{
                border: `2px dashed ${isDragging ? "#0369a1" : "#cbd5e1"}`,
                borderRadius: "10px",
                padding: "2.25rem 1.25rem",
                textAlign: "center",
                cursor: "pointer",
                background: isDragging ? "#eff6ff" : "#f8fafc",
                transition: "all 0.15s",
              }}
            >
              <div style={{ fontSize: "1.8rem", marginBottom: "0.5rem" }}>
                📤
              </div>
              <p
                style={{
                  fontSize: "0.88rem",
                  fontWeight: 600,
                  color: textPrimary,
                  margin: "0 0 0.3rem",
                }}
              >
                Click to choose an image
              </p>
              <p style={{ fontSize: "0.78rem", color: muted, margin: 0 }}>
                or drag &amp; drop it here
              </p>
              <p
                style={{
                  fontSize: "0.7rem",
                  color: dim,
                  margin: "0.6rem 0 0",
                }}
              >
                JPG, PNG, BMP, WEBP — up to 16 MB
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={onFileInputChange}
              />
            </div>

            {previewUrl && (
              <div style={{ position: "relative", marginTop: "1rem" }}>
                <img
                  src={previewUrl}
                  alt="preview"
                  style={{
                    width: "100%",
                    maxHeight: "320px",
                    objectFit: "cover",
                    borderRadius: "10px",
                    border: "1px solid #e2e8f0",
                    display: "block",
                  }}
                />
                <button
                  onClick={clearFile}
                  style={{
                    position: "absolute",
                    top: "8px",
                    right: "8px",
                    width: "28px",
                    height: "28px",
                    borderRadius: "50%",
                    border: "none",
                    background: "rgba(15, 23, 42, 0.65)",
                    color: "#fff",
                    fontSize: "0.9rem",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  aria-label="Remove image"
                >
                  ✕
                </button>
              </div>
            )}

            <button
              onClick={runDetection}
              disabled={!selectedFile || isLoading}
              style={{
                width: "100%",
                marginTop: "1rem",
                padding: "0.8rem",
                background: isLoading || !selectedFile ? "#f1f5f9" : "#0369a1",
                border: `1px solid ${
                  isLoading || !selectedFile ? "#e2e8f0" : "#0369a1"
                }`,
                color: isLoading || !selectedFile ? muted : "#fff",
                borderRadius: "8px",
                fontSize: "0.88rem",
                fontWeight: 700,
                cursor: isLoading || !selectedFile ? "not-allowed" : "pointer",
                letterSpacing: "0.03em",
                transition: "all 0.2s",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.5rem",
              }}
            >
              {isLoading ? (
                <>
                  <span className="wcd-spinner" />
                  Running…
                </>
              ) : (
                "🔍 Run Detection"
              )}
            </button>

            {error && (
              <div
                style={{
                  marginTop: "0.7rem",
                  padding: "0.6rem 0.9rem",
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  borderRadius: "8px",
                  fontSize: "0.75rem",
                  color: "#b91c1c",
                }}
              >
                ⚠ {error}
              </div>
            )}
          </div>
        </div>

        {/* Results column */}
        <div>
          {!result && !isLoading && (
            <div
              style={{
                ...card,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                minHeight: "320px",
                borderStyle: "dashed",
                borderColor: "#cbd5e1",
                background: "#f8fafc",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: "3rem", marginBottom: "0.75rem", opacity: 0.35 }}>
                🌊
              </div>
              <p style={{ color: dim, fontSize: "0.82rem", margin: 0 }}>
                Upload an image and click
                <br />
                <strong style={{ color: muted }}>Run Detection</strong> to see results
              </p>
            </div>
          )}

          {isLoading && (
            <div
              style={{
                ...card,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                minHeight: "320px",
              }}
            >
              <span className="wcd-spinner wcd-spinner-lg" />
              <p style={{ color: muted, fontSize: "0.82rem", marginTop: "1rem" }}>
                Running inference…
              </p>
            </div>
          )}

          {result && !isLoading && (
            <div style={card}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "1rem",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                }}
              >
                <h2 style={{ ...sectionLabel, marginBottom: 0 }}>Result</h2>
                <span style={{ fontSize: "0.78rem", color: muted }}>
                  {result.num_detections} detection
                  {result.num_detections === 1 ? "" : "s"}
                </span>
              </div>

              <div style={{ marginBottom: "0.9rem" }}>
                {result.ood_enabled ? (
                  <span
                    style={{
                      display: "inline-block",
                      padding: "0.3rem 0.8rem",
                      borderRadius: "999px",
                      fontSize: "0.72rem",
                      fontWeight: 700,
                      background: result.is_ood ? "#fef2f2" : "#f0fdf4",
                      color: result.is_ood ? "#dc2626" : "#059669",
                      border: `1px solid ${
                        result.is_ood ? "#fecaca" : "#bbf7d0"
                      }`,
                    }}
                  >
                    {result.is_ood ? "OUT-OF-DISTRIBUTION" : "IN-DISTRIBUTION"}
                    {" · "}
                    Mahalanobis={result.mahalanobis_dist} (threshold=
                    {result.ood_threshold})
                  </span>
                ) : (
                  <span
                    style={{
                      display: "inline-block",
                      padding: "0.3rem 0.8rem",
                      borderRadius: "999px",
                      fontSize: "0.72rem",
                      fontWeight: 600,
                      background: "#f1f5f9",
                      color: muted,
                      border: "1px solid #e2e8f0",
                    }}
                  >
                    OOD detection not configured
                  </span>
                )}
              </div>

              <img
                src={`data:image/jpeg;base64,${result.annotated_image_base64}`}
                alt="annotated result"
                style={{
                  width: "100%",
                  borderRadius: "10px",
                  border: "1px solid #e2e8f0",
                  display: "block",
                }}
              />

              {result.detections.length > 0 ? (
                <div style={{ overflowX: "auto" }}>
                  <table
                    style={{
                      width: "100%",
                      marginTop: "1rem",
                      fontSize: "0.78rem",
                      borderCollapse: "collapse",
                    }}
                  >
                    <thead>
                      <tr style={{ textAlign: "left" }}>
                        {["#", "Class", "Confidence", "BBox (x1, y1, x2, y2)"].map(
                          (h) => (
                            <th
                              key={h}
                              style={{
                                padding: "0.5rem 0.6rem",
                                borderBottom: "1px solid #e2e8f0",
                                color: muted,
                                fontSize: "0.68rem",
                                textTransform: "uppercase",
                                letterSpacing: "0.06em",
                                whiteSpace: "nowrap",
                              }}
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
                          <td
                            style={{
                              padding: "0.5rem 0.6rem",
                              borderBottom: "1px solid #f1f5f9",
                              color: textPrimary,
                            }}
                          >
                            {i + 1}
                          </td>
                          <td
                            style={{
                              padding: "0.5rem 0.6rem",
                              borderBottom: "1px solid #f1f5f9",
                              color: "#0369a1",
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {d.class_name}
                          </td>
                          <td
                            style={{
                              padding: "0.5rem 0.6rem",
                              borderBottom: "1px solid #f1f5f9",
                              color: textPrimary,
                            }}
                          >
                            {d.confidence.toFixed(3)}
                          </td>
                          <td
                            style={{
                              padding: "0.5rem 0.6rem",
                              borderBottom: "1px solid #f1f5f9",
                              color: dim,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {d.bbox_xyxy.map((v) => v.toFixed(1)).join(", ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p
                  style={{
                    color: muted,
                    fontSize: "0.8rem",
                    marginTop: "1rem",
                    marginBottom: 0,
                  }}
                >
                  No contamination detected in this image.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <style>{`
        .wcd-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 1.25rem;
        }
        @media (min-width: 760px) {
          .wcd-grid {
            grid-template-columns: minmax(280px, 400px) 1fr;
            align-items: start;
          }
        }
        .wcd-spinner {
          display: inline-block;
          width: 14px;
          height: 14px;
          border: 2px solid rgba(255,255,255,0.4);
          border-top-color: #fff;
          border-radius: 50%;
          animation: wcd-spin 0.7s linear infinite;
        }
        .wcd-spinner-lg {
          width: 36px;
          height: 36px;
          border: 3px solid #e2e8f0;
          border-top-color: #0369a1;
        }
        @keyframes wcd-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}